# Playout Script for RadioPlay One (Liquidsoap 2.2.4)

# Enable log outputs
set("log.file.path", "/home/ubuntu/radioplayone/storage/liquidsoap.log")
set("log.stdout", true)
set("log.level", 3)

# Enable Telnet server for control commands
set("server.telnet", true)
set("server.telnet.port", 1234)
set("server.telnet.bind_addr", "127.0.0.1")

# === 1. MUSIC SOURCE ===
def get_next_track() =
  # Fetch next cued music track path from Node.js Express server
  let body = http.get("http://127.0.0.1:3000/api/playout/next-track-path")
  request.create(body)
end
music = request.dynamic(id="playout", get_next_track)

# Track start callback
def on_track_start(m) =
  # Notify Node.js API that a new music track has started playing
  ignore(http.post("http://127.0.0.1:3000/api/playout/track-started", headers=[("Content-Type", "application/json")], data="{}"))
end
music = source.on_track(music, on_track_start)

# === 2. IMAGING / SWEEPER SOURCE ===
def get_next_imaging() =
  # Fetch next auto-inserted sweeper or station ID from Node.js Express server
  let body = http.get("http://127.0.0.1:3000/api/playout/next-imaging-path")
  request.create(body)
end
imaging = request.dynamic(id="imaging", get_next_imaging)

# === 3. INSTANT CARTS SOURCE ===
# Dynamic interactive queue for manual soundboard triggers
carts = request.queue(id="carts_queue")

# Mix A: Duck music to 15% gain when imaging/sweeper plays
mixed_stream = smooth_add(duration=0.5, p=0.15, music, imaging)

# Mix B: Duck the resulting program to 25% gain when manual instant carts play
mixed_stream = smooth_add(duration=0.4, p=0.25, mixed_stream, carts)

# Fallback safety silence in case of empty sources
safety_silence = blank()
stream = fallback(track_sensitive=false, [mixed_stream, safety_silence])

# Master volume control (interactive, adjustable via Telnet: var.set master_vol = 0.75)
master_vol = interactive.float("master_vol", 1.0)
stream = amplify(override="", id="master_amplify", master_vol, stream)

# Stream output to local Icecast playout mount
output.icecast(%mp3(bitrate=128),
  id="playout_output",
  host="localhost",
  port=8000,
  password="hackme",
  mount="playout",
  name="RadioPlay Playout Stream",
  description="Automated Playout Feed",
  stream)
