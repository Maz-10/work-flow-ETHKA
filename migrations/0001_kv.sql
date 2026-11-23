-- مخزنُ صفحة رسم سير العمل: مفاتيحُ وقيمُ JSON (link:<مفتاح> · state:<مفتاح> · templates)
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at INTEGER NOT NULL);
