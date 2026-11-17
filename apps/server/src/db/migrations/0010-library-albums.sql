-- albums is the stable identity table. Only albums with a real track reference are
-- browseable, independently of the materialized canonical count (including CUE rows).
CREATE VIEW library_albums AS
SELECT a.* FROM albums a WHERE EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = a.id);

CREATE INDEX plays_album_history_idx ON plays (album_id);
CREATE INDEX annotations_album_item_idx ON annotations (item_id) WHERE item_type = 'album';
