use std::{ffi::c_void, io, mem::size_of};
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::System::Threading::{
    DeleteProcThreadAttributeList, InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
    UpdateProcThreadAttribute,
};

const HANDLE_LIST: usize = 0x0002_0002;
const JOB_LIST: usize = 0x0002_000d;
const PSEUDOCONSOLE: usize = 0x0002_0016;

pub(super) struct Attributes {
    // Pointer alignment is required even though Windows reports a byte count.
    storage: Vec<usize>,
    handles: Vec<HANDLE>,
    jobs: Vec<HANDLE>,
}

impl Attributes {
    pub(super) fn new(count: u32) -> io::Result<Self> {
        let mut bytes = 0;
        unsafe {
            InitializeProcThreadAttributeList(std::ptr::null_mut(), count, 0, &mut bytes);
        }
        if bytes == 0 || bytes > 1024 * 1024 {
            return Err(io::Error::other(
                "Windows returned an unusable startup attribute size.",
            ));
        }
        let mut storage = vec![0usize; bytes.div_ceil(size_of::<usize>())];
        if unsafe {
            InitializeProcThreadAttributeList(storage.as_mut_ptr().cast(), count, 0, &mut bytes)
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            storage,
            handles: Vec::new(),
            jobs: Vec::new(),
        })
    }

    pub(super) fn raw(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.storage.as_mut_ptr().cast()
    }

    pub(super) fn job(&mut self, job: HANDLE) -> io::Result<()> {
        self.jobs = vec![job];
        let value = self.jobs.as_mut_ptr().cast();
        self.update(JOB_LIST, value, size_of::<HANDLE>())
    }

    pub(super) fn handles(&mut self, handles: Vec<HANDLE>) -> io::Result<()> {
        self.handles = handles;
        let value = self.handles.as_mut_ptr().cast();
        let bytes = std::mem::size_of_val(self.handles.as_slice());
        self.update(HANDLE_LIST, value, bytes)
    }

    pub(super) fn terminal(&mut self, console: isize) -> io::Result<()> {
        self.update(PSEUDOCONSOLE, console as *mut c_void, size_of::<HANDLE>())
    }

    fn update(&mut self, kind: usize, value: *mut c_void, bytes: usize) -> io::Result<()> {
        if unsafe {
            UpdateProcThreadAttribute(
                self.raw(),
                0,
                kind,
                value,
                bytes,
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe { DeleteProcThreadAttributeList(self.raw()) };
    }
}
