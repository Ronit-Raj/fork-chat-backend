# Fork-chat

This is the backend for an ai chat app. The biggest feature is that I allow endless forking / branching

## DB model

- ChatId: self explantory a uuid for every chat on our app(indedxed) 
- userId: again self explantory a uuid for every user(indexed)
- messages: stores the chat as json in the standard role,message format
- path: this is intresting , it is the path of the chat in the tree (indexed)

## Auth
Implement standard jwt auth(bearer token) skip refresh tokens for now.No OAuth as well. Build the table for this , i trust you with these details. 

## Path description 
There are many ways to store a hirerchial data in a SQL database. I have selected materialized path 
for this application. I am aware of the tradeoffs namely 
- violating normalisation 
- potentially higher storage requirements 
but i think this is the simplest one and get our job done quite elegentaly.
Here's how it would work every chat row has a path column 
- ```/``` is the root
- User creates a new chat we add another row ```/{uuid1}``` 
- User forks the first chat we add another row with the path ```/{uuid1}/{uuid2}```
- User creates another fork of the first chat, we add another row with path ```/{uuid1}/{uuid3}```
- User creates an entirely different chat , we create a row with path col as ```/{uuid4}```

## Routes (all routes are protected unless stated otherwise)
1. ``` GET /:chatid``` <br>
Returns the messages of this chatid. Return 404 if not found.

2. ```POST /fork/:chatid``` <br>
Creates a new fork branch of the chat. No request body. Find this chatId in the DB. A simple select statement on the chatId column. Once found generate a new UUID. Create a new row by copying the messages, path and userId from this result. Append the generated UUID to the end of the path. The fork starts as a copy of the parent's history; the frontend then continues it with ```POST /message/:chatid``` to send the first message and stream the response. Return 201 with the new chat.

3. ```POST /message/:chatid``` <br>
 use SSE to stream the reponse back to the frontend  This is fired for a top-level or message or for forked chats beyond the first message. Appends question and response to the message array. 

4. ```GET /chats/:userid``` <br>
Get all the top level chats for this user. Should be simple like 
```SELECT * FROM USER WHERE userid = {userid} AND  path={/}```

5. ```GET /children/:chatid``` <br>
Use the like operator chatid% and send all the children of this chatid.

6. ```DELETE /:chatid``` <br>
Clear from name. It is cascading request all the forks are deleted the entire tree. 