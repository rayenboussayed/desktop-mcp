# Tools reference

The tool set changes depending on the permission policy. Tools whose capabilities are not
granted are not even listed. The server also exposes `think`, `permissions_describe`,
`plugin_status`, `list_keys` and `screen_highlight`.

## Mouse

- `mouse_position`: current pointer position.
- `move_mouse`: move to absolute logical pixels.
- `mouse_move_relative`: move relative to the current position.
- `click`: click any button, with double-click and triple-click support.
- `mouse_press`, `mouse_release`: hold or release a button.
- `mouse_drag`: drag from a start to end point.
- `scroll`: vertical and horizontal scrolling.

## Keyboard

- `type_text`: type text with speed support and hard maximum length.
- `press_key`: key combinations, media keys and numpad.
- `key_down`, `key_up`: hold or release keys.
- `list_keys`: supported key names.

## Screen

- `screen_size`
- `screenshot`: full or regional capture.
- `screenshot_save`: save a capture to a file.
- `screen_color_at`: read one pixel colour.
- `screen_highlight`: highlight a region.
- `screen_find_image`, `screen_find_images`, `screen_wait_for_image`: image matching.
- `click_image`: find and click an image.
- `screen_read_text`: OCR reading.
- `screen_find_text`: OCR search with exact, contains and fuzzy modes.
- `screen_wait_for_text`: wait for text to appear.
- `click_text`: find and click text.
- `screen_find_color`: find colour regions.
- `screen_record`: capture frames, and MP4 through `ffmpeg`.

## Windows

- `window_list`: title, geometry and active state.
- `window_active`: active window.
- `window_wait_for`: wait for a matching window.
- `window_focus`: bring a window to the front.
- `window_move`, `window_resize`
- `window_minimize`, `window_restore`
- `window_close`.

## Clipboard

- `clipboard_get`, `clipboard_set`, `clipboard_clear`
- `clipboard_copy`: press the platform copy shortcut and return copied text.
- `clipboard_paste`: put text on the clipboard, send the paste shortcut, and restore
  the previous value.

## System

- `system_info`
- `get_env`
- `list_processes`
- `kill_process`
- `run_command`
- `open_path`
- `permissions_describe`

## Files

- `read_file`, `write_file`, `edit_file`
- `list_dir`, `find_files`, `search_in_files`
- `make_dir`, `copy_path`, `move_path`, `delete_path`

## Web (only if `--allow-web`)

- `web_search`
- `fetch_url`
EOF