-- Full-text search over knowledge documents. Self-contained (it stores its own copy
-- of the text) and keyed by doc_id, not rowid: VACUUM may renumber implicit rowids,
-- which would silently break an external-content mapping.
CREATE VIRTUAL TABLE `knowledge_fts` USING fts5(doc_id UNINDEXED, title, body, tags, tokenize='porter unicode61');
--> statement-breakpoint
CREATE TRIGGER `knowledge_fts_ai` AFTER INSERT ON `knowledge_docs` BEGIN
  INSERT INTO knowledge_fts(doc_id, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
END;
--> statement-breakpoint
CREATE TRIGGER `knowledge_fts_au` AFTER UPDATE OF title, body, tags ON `knowledge_docs` BEGIN
  DELETE FROM knowledge_fts WHERE doc_id = old.id;
  INSERT INTO knowledge_fts(doc_id, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
END;
--> statement-breakpoint
CREATE TRIGGER `knowledge_fts_ad` AFTER DELETE ON `knowledge_docs` BEGIN
  DELETE FROM knowledge_fts WHERE doc_id = old.id;
END;
