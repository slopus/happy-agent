# Agent status — learnings

## The status line belongs to rich tasks

Kirill decided that `set_status` is given only while the person an agent works for has
`tasks.rich` on, with no exception for phones, because the minimal list is to drop status lines.
The tool and its instruction are withheld at tool assembly, so an agent with rich tasks off is
offered exactly what it was before status lines existed; the durable function name
`stories.set-status` and the tool's text are unchanged, and a line already set is never cleared by
withholding the tool. A bot follows the person whose message its turn answers, which this module
records through `RichTasksModule.notePerson` because module stores are not shared.
