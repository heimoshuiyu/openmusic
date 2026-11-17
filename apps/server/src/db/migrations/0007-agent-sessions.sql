-- Agent 会话归属（docs/08-ai-agent.md §4）：会话内容（消息/事件）住在
-- OpenCode 宿主自己的 sqlite 库（data/agent-sessions.db，独立决策），
-- PG 只记「哪个会话属于哪个用户」——多用户隔离与工具执行期身份解析
--（music_* 工具按 sessionID 反查 owner_user_id）的咽喉表。
CREATE TABLE agent_sessions (
  id            text PRIMARY KEY,             -- OpenCode sessionID（ses_*）
  owner_user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agent_sessions_owner_idx ON agent_sessions (owner_user_id);
