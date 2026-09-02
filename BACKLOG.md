
Make it possible to switch between providers mid-session.


When running a long running bash task and then pressing ESC to abort that then the entire bash tool output up to that point seems to be thrown out. That output could be useful for the agent, I guess. Figure out a way to keep that output up until the point where it was aborted/interrupted.

Improve the web fetch errors to be more compact, don't need the entire stack trace.
web_fetch: https://www.elgiganten.se/kundtjanst/kopvillkor-for-elgigantens-foretagskunder                                                                                                                                                                             ✗
Error: Request failed with status 429
at Object.execute (/home/jonas/dev/pace/dist/tools/web-fetch.js:136:23)
at process.processTicksAndRejections (node:internal/process/task_queues:103:5)
at async executeToolUseBlock (/home/jonas/dev/pace/dist/app.js:1402:31)
at async runOne (/home/jonas/dev/pace/dist/app.js:1450:24)
at async Promise.all (index 1)
at async prompt (/home/jonas/dev/pace/dist/app.js:1802:37)
at async Object.handleUserInput [as onSubmit] (/home/jonas/dev/pace/dist/app.js:1536:9)
