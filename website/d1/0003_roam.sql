-- Roaming the 3D city on foot and by car and boat: when the player's stored position was last reported, so the server can check how far
-- they could have got in the time since. Run once (SQLite cannot add a column "if not exists"):
--   npx wrangler d1 execute aretia-game --remote --file=d1/0003_roam.sql
alter table game_player_cities add column pos_at integer;
