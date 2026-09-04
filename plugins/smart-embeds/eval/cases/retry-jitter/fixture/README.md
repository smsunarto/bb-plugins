# retry-helper

Retry wrapper used by the outbound webhook sender and the object storage
client.

It repeats only the failures that are safe to repeat, connection resets and
429/5xx responses, and waits longer after each attempt. The wait doubles every
attempt and is capped at `maxDelayMs` so a long outage does not park a request
for minutes.
