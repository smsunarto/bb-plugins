List what Sauce Live offers before starting a device: `kind: "apps"` lists the newest builds in Sauce app storage (about 10; add `query` to find older ones); `kind: "devices"` lists real devices matching `query` with status, OS, and screen size.

Sauce shows only the devices that can run the selected build, so for `kind: "devices"` pass the same `app` you will give `sauce_start` (omitted, the newest build, as in `sauce_start`). The result's `app` names the build the list belongs to.

Use it to choose `app`, `device`, and `os` for `sauce_start`. It navigates the shared Sauce browser, so it fails with `session_active` while a session is open and with `held_by_other_thread` while another thread holds the device. Uploading builds is not supported here.
