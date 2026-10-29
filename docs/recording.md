# Recording

`screen_record` captures PNG frames at a specified duration, FPS and region.

- Output is written to `out_dir`.
- PNG frames are always produced.
- MP4 output is produced only when `ffmpeg` is present.
- Duration and FPS have safe limits and are validated before recording.
- Recording requires `screen.record` plus `files.write`.
EOF