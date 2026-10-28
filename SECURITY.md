# Security

If you find a security problem, please report it privately: use the repository's **Security** tab,
**Report a vulnerability**. Please do not open a public issue for it.

What matters most here: the end-to-end encryption of closed chats, anything that lets someone read or change
another person's messages, the admin token, and anything that makes the server store more than it says it does.

Known limits, so you do not need to report them: boards and open chats are public, and whoever runs a server can
change the code it serves, and a server that watches live can see which phone sends what. A copy of the database alone cannot link posts to a phone.
A hostile server can still reorder or hold back messages in a closed chat (it cannot change a sender, replay a message or edit one unnoticed).
