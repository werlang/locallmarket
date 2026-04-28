# Bugs

- Worker availability must be tied to the active assignment and socket session: late chunk/completion/failure events from a disconnected session must be ignored so a reconnected worker is not released for the wrong job.
