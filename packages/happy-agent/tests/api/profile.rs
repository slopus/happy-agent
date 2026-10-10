//! Exercise the existing standalone profile contract through the built daemon.
use super::*;
struct Cleanup<'a>(&'a Installation);
impl Drop for Cleanup<'_> {
    fn drop(&mut self) {
        use std::io::{Read, Write};
        let directory = self.0.home.join("agent");
        if let (Ok(token), Ok(mut socket)) = (
            std::fs::read_to_string(directory.join("token")),
            std::os::unix::net::UnixStream::connect(directory.join("server.sock")),
        ) {
            let _ = socket.set_read_timeout(Some(Duration::from_secs(1)));
            let _ = socket.set_write_timeout(Some(Duration::from_secs(1)));
            let _=socket.write_all(format!("POST /v0/shutdown HTTP/1.1\r\nHost: happy\r\nAuthorization: Bearer {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",token.trim()).as_bytes());
            let mut response = [0; 4096];
            let _ = socket.read(&mut response);
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while directory.join("daemon.pid").exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn standalone_profile_versions_photos_and_events_survive_restart() {
    let (endpoint, mut requests, provider) = scripted_provider(1).await;
    let installation = Installation::new();
    installation.seed(&endpoint);
    installation.command("start");
    let _cleanup = Cleanup(&installation);
    exchange(&mut requests)
        .await
        .respond
        .send(text_response("profile-ready"))
        .unwrap();
    let (client, token) = installation.client();
    let fetched = client
        .get("http://happy/v0/profile")
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(
        fetched.status(),
        200,
        "The existing standalone profile contract must be available."
    );
    let initial: Value = fetched.json::<Value>().await.unwrap()["profile"].clone();
    for field in ["name", "email", "photo", "userId"] {
        assert_eq!(initial[field], Value::Null);
    }
    assert_eq!(
        initial.as_object().unwrap().len(),
        6,
        "Private profile identity and installation ownership never reach HTTP."
    );
    assert_eq!(
        uuid::Uuid::parse_str(initial["version"].as_str().unwrap())
            .unwrap()
            .get_version_num(),
        7
    );
    let missing = client
        .patch("http://happy/v0/profile")
        .bearer_auth(&token)
        .json(&json!({"name":"Ada"}))
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), 400);
    let updated=client.patch("http://happy/v0/profile").bearer_auth(&token).header("If-Match",initial["version"].as_str().unwrap()).json(&json!({"name":"Ada Lovelace","email":"ada@example.test","mutationId":"profile-contract-mutation"})).send().await.unwrap();
    assert_eq!(updated.status(), 200);
    let named: Value = updated.json::<Value>().await.unwrap()["profile"].clone();
    assert!(named["version"].as_str().unwrap() > initial["version"].as_str().unwrap());
    let journal = client
        .get("http://happy/v0/events?limit=1000")
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    let event = journal["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|event| {
            event["type"] == "profile.updated" && event["payload"]["version"] == named["version"]
        })
        .expect("The saved mutation publishes the existing profile event.");
    assert_eq!(event["payload"]["previousVersion"], initial["version"]);
    assert_eq!(event["payload"]["profile"], named);
    assert_eq!(event["payload"]["mutationId"], "profile-contract-mutation");
    let conflict = client
        .patch("http://happy/v0/profile")
        .bearer_auth(&token)
        .header("If-Match", initial["version"].as_str().unwrap())
        .json(&json!({"name":"Old write"}))
        .send()
        .await
        .unwrap();
    assert_eq!(conflict.status(), 409);
    assert_eq!(conflict.json::<Value>().await.unwrap()["profile"], named);
    let pixel = image::RgbaImage::from_pixel(3, 2, image::Rgba([200, 40, 80, 255]));
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(pixel)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    let uploaded = client
        .put("http://happy/v0/profile/photo")
        .bearer_auth(&token)
        .header("If-Match", named["version"].as_str().unwrap())
        .header("Content-Type", "image/png")
        .body(png.into_inner())
        .send()
        .await
        .unwrap();
    assert_eq!(uploaded.status(), 200);
    let pictured = uploaded.json::<Value>().await.unwrap()["profile"].clone();
    assert!(pictured["photo"]["thumbhash"].as_str().is_some());
    let bytes = client
        .get("http://happy/v0/profile/photo")
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(bytes.status(), 200);
    assert_eq!(bytes.headers()["content-type"], "image/webp");
    let etag = bytes.headers()["etag"].to_str().unwrap().to_owned();
    let bytes = bytes.bytes().await.unwrap();
    let decoded = image::load_from_memory_with_format(&bytes, image::ImageFormat::WebP).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (3, 2));
    let cached = client
        .get("http://happy/v0/profile/photo")
        .bearer_auth(&token)
        .header("If-None-Match", &etag)
        .send()
        .await
        .unwrap();
    assert_eq!(cached.status(), 304);
    installation.command("stop");
    installation.command("start");
    let (client, token) = installation.client();
    let restored = client
        .get("http://happy/v0/profile")
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(restored["profile"], pictured);
    let deleted = client
        .delete("http://happy/v0/profile/photo")
        .bearer_auth(&token)
        .header("If-Match", pictured["version"].as_str().unwrap())
        .send()
        .await
        .unwrap();
    assert_eq!(deleted.status(), 200);
    let cleared = deleted.json::<Value>().await.unwrap()["profile"].clone();
    assert_eq!(cleared["photo"], Value::Null);
    let repeated = client
        .delete("http://happy/v0/profile/photo")
        .bearer_auth(&token)
        .header("If-Match", cleared["version"].as_str().unwrap())
        .send()
        .await
        .unwrap();
    assert_eq!(repeated.status(), 200);
    assert_eq!(repeated.json::<Value>().await.unwrap()["profile"], cleared);
    assert_eq!(
        client
            .get("http://happy/v0/profile/photo")
            .bearer_auth(&token)
            .header("If-None-Match", etag)
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    provider.await.unwrap();
}
