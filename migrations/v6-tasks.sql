-- v6: دفتر کارهای مدیر ساختمان — ثبت کارهای انجام‌شده در طول سال، هزینهٔ هر کار
-- (از صندوق کسر می‌شود) و مدارک پیوست (فیش، قرارداد، برگه بازدید آسانسور و…)
CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'سایر',
  description TEXT DEFAULT '',
  cost        INTEGER NOT NULL DEFAULT 0,   -- تومان؛ از صندوق ساختمان کسر می‌شود
  done_at     INTEGER,                      -- تاریخ انجام (unix, تهران)
  created_by  INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tasks_done ON tasks(done_at);

-- متادیتای مدارک پیوست کارها
CREATE TABLE IF NOT EXISTS task_files (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL,
  name       TEXT NOT NULL,
  mime       TEXT DEFAULT '',
  size       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_files_task ON task_files(task_id);

-- محتوای فایل در قطعات ~۶۰ کیلوبایتی (سقف طول گزارهٔ D1) — هنگام دانلود
-- به ترتیب idx دوباره سرهم می‌شود
CREATE TABLE IF NOT EXISTS task_file_chunks (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL,
  idx     INTEGER NOT NULL,
  data    BLOB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_chunks_file ON task_file_chunks(file_id, idx);
