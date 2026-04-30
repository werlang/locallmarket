# Bugs

- Worker availability must be tied to the active assignment and socket session: late chunk/completion/failure events from a disconnected session must be ignored so a reconnected worker is not released for the wrong job.
- OpenAI auto-match selection must reject offers whose worker ownership does not cohere with the offer owner before trusting offer price fields; otherwise stale or spoofed rows can influence internal pricing/selection.
