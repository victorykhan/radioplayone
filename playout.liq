# Playout Script for RadioPlay One (Liquidsoap 2.2.4)

# Enable log outputs
set("log.file.path", "/home/ubuntu/radioplayone/storage/liquidsoap.log")
set("log.stdout", true)
set("log.level", 3)

# Enable Telnet server for control commands
set("server.telnet", true)
set("server.telnet.port", 1234)
set("server.telnet.bind_addr", "127.0.0.1")

# Get next track path from Node.js Express server
def get_next_track() =
  # Fetch from API directly as a string
  let body = http.get("http://127.0.0.1:3000/api/playout/next-track-path")
  # Return the request created from the annotated string
  request.create(body)
end

# Create dynamic request source
playout = request.dynamic(id="playout", get_next_track)


# Track start callback
def on_track_start(m) =
  # Notify Node.js API that a new track has started playing
  ignore(http.post("http://127.0.0.1:3000/api/playout/track-started", headers=[("Content-Type", "application/json")], data="{}"))
end

playout = source.on_track(playout, on_track_start)

# Fallback in case playout source is unavailable or empty
safety_silence = blank()
stream = fallback(track_sensitive=false, [playout, safety_silence])

# Stream output to local Icecast playout mount
output.icecast(%mp3(bitrate=128),
  host="localhost",
  port=8000,
  password="hackme",
  mount="playout",
  name="RadioPlay Playout Stream",
  description="Automated Playout Feed",
  stream)
