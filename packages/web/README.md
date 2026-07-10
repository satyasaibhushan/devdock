# @devdock/web

Svelte + xterm.js dashboard. A thin client of the daemon's HTTP/WS API.

The terminal surface uses xterm.js over daemon-owned PTYs. Host and pod shells
run directly; managed dev sessions attach to their existing tmux session.
Scrolling, selection, and clipboard behavior stay local to xterm.js.
