CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt TEXT NOT NULL);
CREATE TABLE sources (id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, environment TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, lastEventAt TEXT, error TEXT, accepted INTEGER NOT NULL DEFAULT 0, rejected INTEGER NOT NULL DEFAULT 0);
CREATE TABLE workspaces (id TEXT PRIMARY KEY, sourceId TEXT NOT NULL REFERENCES sources(id), projectId TEXT NOT NULL REFERENCES projects(id), path TEXT NOT NULL, UNIQUE(sourceId,path));
CREATE TABLE chats (id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), provider TEXT NOT NULL, sourceId TEXT REFERENCES sources(id), externalId TEXT, name TEXT NOT NULL DEFAULT '', providerTitle TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', jiraKey TEXT NOT NULL DEFAULT '', jiraUrl TEXT NOT NULL DEFAULT '', archived INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'unknown', lifecycle TEXT NOT NULL DEFAULT 'open', preview TEXT NOT NULL DEFAULT '', lastEventAt TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, UNIQUE(sourceId,externalId));
CREATE TABLE activities (id TEXT PRIMARY KEY, chatId TEXT NOT NULL REFERENCES chats(id), observedAt TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL);
CREATE INDEX activity_chat_time ON activities(chatId,observedAt DESC);
CREATE TABLE processed_events (sourceId TEXT NOT NULL REFERENCES sources(id), eventId TEXT NOT NULL, PRIMARY KEY(sourceId,eventId));
PRAGMA user_version = 1;
