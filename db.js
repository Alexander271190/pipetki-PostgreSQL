const { Pool } = require('pg');

// ============================================================
// ПУЛ СОЕДИНЕНИЙ
// ============================================================
const pool = new Pool({
  host:     process.env.DB_HOST || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'pipette',
  user:     process.env.DB_USER || 'pipette',
  password: process.env.DB_PASSWORD || 'pipette_secret',
  max: 10,
  idleTimeoutMillis: 30000,
});

async function query(sql, params = []) {
  return pool.query(sql, params);
}

async function getConnection() {
  const client = await pool.connect();
  return {
    query: (sql, params = []) => client.query(sql, params),
    beginTransaction: () => client.query('BEGIN'),
    commit:           () => client.query('COMMIT'),
    rollback:         async () => { try { await client.query('ROLLBACK'); } catch (e) {} },
    release:          () => client.release(),
  };
}

// ============================================================
// СХЕМА
// ============================================================
async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      login TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      full_name TEXT NOT NULL,
      position TEXT NOT NULL,
      department TEXT,
      role TEXT DEFAULT 'user',
      extra_permissions TEXT DEFAULT '[]',
      only_own_department INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pipettes (
      id TEXT PRIMARY KEY,
      serial TEXT,
      manufacturer TEXT,
      model TEXT NOT NULL,
      volume TEXT,
      department TEXT,
      subdivision TEXT,
      "interval" INTEGER DEFAULT 12,
      last_calibration TEXT,
      cert TEXT,
      last_result TEXT DEFAULT 'pass',
      active INTEGER DEFAULT 1,
      responsible TEXT,
      location TEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS calibration_history (
      id SERIAL PRIMARY KEY,
      pipette_id TEXT NOT NULL REFERENCES pipettes(id) ON DELETE CASCADE,
      "date" TEXT NOT NULL,
      cert TEXT,
      result TEXT DEFAULT 'pass',
      org TEXT,
      note TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      user_full_name TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS departments (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      enabled INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS subdivisions (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      enabled INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS filter_config (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      type TEXT NOT NULL,
      field_id TEXT,
      enabled INTEGER DEFAULT 1,
      options_source TEXT,
      filter_order INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS system_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS field_config (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      type TEXT NOT NULL,
      required INTEGER DEFAULT 0,
      enabled INTEGER DEFAULT 1,
      options TEXT DEFAULT '[]',
      default_value TEXT DEFAULT '',
      field_order INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS export_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      fields TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await seedInitialData();
}

// ============================================================
// НАЧАЛЬНЫЕ ДАННЫЕ
// ============================================================
async function seedInitialData() {
  // --- Пользователи ---
  const { rows: uc } = await pool.query('SELECT COUNT(*)::int AS c FROM users');
  if (uc[0].c === 0) {
    const sql = `INSERT INTO users (id, login, password, full_name, position, department, role, extra_permissions)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`;
    await pool.query(sql, ['admin1',  'admin',  'admin',  'Администратор', 'Главный метролог',    null,                     'admin',      '[]']);
    await pool.query(sql, ['senior1', 'senior', 'senior', 'Петров Петр',   'Старший лаборант',    'Гематологический отдел', 'senior_lab', '[]']);
    await pool.query(sql, ['user1',   'user',   'user',   'Иванов Иван',   'Лаборант',            'Биохимический отдел',    'user',       '[]']);
  }

  // --- Отделы ---
  const { rows: dc } = await pool.query('SELECT COUNT(*)::int AS c FROM departments');
  if (dc[0].c === 0) {
    const deps = [
      'Гематологический отдел',
      'Биохимический отдел',
      'Коагулогический отдел',
      'Экспресс отдел',
      'Изосерологический отдел',
      'Серологический отдел',
      'ГИМИ',
      'Бактериологический отдел'
    ];
    for (const d of deps) {
      await pool.query('INSERT INTO departments (name) VALUES ($1)', [d]);
    }
  }

  // --- Подразделения ---
  const { rows: sc } = await pool.query('SELECT COUNT(*)::int AS c FROM subdivisions');
  if (sc[0].c === 0) {
    const subs = [
      'Клинико-диагностическая лаборатория',
      'ГИМИ',
      'Микробиологическая лаборатория'
    ];
    for (const s of subs) {
      await pool.query('INSERT INTO subdivisions (name, enabled) VALUES ($1, 1)', [s]);
    }
  }

  // --- Системные настройки ---
  const { rows: ssc } = await pool.query('SELECT COUNT(*)::int AS c FROM system_settings');
  if (ssc[0].c === 0) {
    await pool.query(`INSERT INTO system_settings (setting_key, setting_value) VALUES ('warn_days', '30')`);
  }

  // --- Поля формы ---
  const { rows: fc } = await pool.query('SELECT COUNT(*)::int AS c FROM field_config');
  if (fc[0].c === 0) {
    const ins = `INSERT INTO field_config (id, label, type, required, enabled, options, default_value, field_order)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`;
    const fields = [
      ['id',              'Внутренний номер',              'text',     1, 1, '[]',                    '',     1],
      ['serial',          'Серийный номер',                'text',     0, 1, '[]',                    '',     2],
      ['manufacturer',    'Производитель',                 'text',     0, 1, '[]',                    '',     3],
      ['model',           'Модель',                        'text',     1, 1, '[]',                    '',     4],
      ['volume',          'Объём (мкл)',                   'text',     0, 1, '[]',                    '',     5],
      ['department',      'Отдел',                         'select',   0, 1, '[]',                    '',     6],
      ['subdivision',     'Подразделение',                 'select',   0, 1, '[]',                    '',     7],
      ['interval',        'Межповерочный интервал (мес.)', 'number',   1, 1, '[]',                    '12',   8],
      ['lastCalibration', 'Дата последней поверки',        'date',     1, 1, '[]',                    '',     9],
      ['cert',            'Номер свидетельства',           'text',     0, 1, '[]',                    '',     10],
      ['result',          'Результат поверки',             'select',   0, 1, '["pass","fail","wip"]','pass', 11],
      ['active',          'Статус эксплуатации',           'select',   0, 1, '["true","false"]',      'true', 12],
      ['responsible',     'Ответственный сотрудник',       'text',     0, 1, '[]',                    '',     13],
      ['location',        'Место хранения',                'text',     0, 1, '[]',                    '',     14],
      ['notes',           'Примечание',                    'textarea', 0, 1, '[]',                    '',     15]
    ];
    for (const f of fields) await pool.query(ins, f);
  }

  // --- Настройки экспорта ---
  const { rows: ec } = await pool.query('SELECT COUNT(*)::int AS c FROM export_settings');
  if (ec[0].c === 0) {
    const defaultExport = [
      'id', 'serial', 'manufacturer', 'model', 'volume', 'department',
      'lastCalibration', 'nextCalibration', 'interval', 'daysLeft',
      'responsible', 'location', 'status', 'cert', 'notes'
    ];
    await pool.query('INSERT INTO export_settings (id, fields) VALUES (1, $1)', [JSON.stringify(defaultExport)]);
  }

  // --- Демо-пипетки ---
  const { rows: pc } = await pool.query('SELECT COUNT(*)::int AS c FROM pipettes');
  if (pc[0].c === 0) {
    const today = new Date();
    const ago = (m) => {
      const d = new Date(today);
      d.setMonth(d.getMonth() - m);
      return d.toISOString().slice(0, 10);
    };

    const insPip = `INSERT INTO pipettes
      (id, serial, manufacturer, model, volume, department, subdivision, "interval",
       last_calibration, cert, last_result, active, responsible, location, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`;

    await pool.query(insPip, ['P-001', 'EP2024001', 'Eppendorf', 'Research Plus', '1000', 'Гематологический отдел',
      'Клинико-диагностическая лаборатория', 12, ago(11), 'С-АБ-1234567/2025', 'pass', 1,
      'Иванова М.С.', 'Лаб. 201, шкаф 3', '']);

    await pool.query(insPip, ['P-002', 'EP2024002', 'Eppendorf', 'Research Plus', '100', 'Биохимический отдел',
      'Клинико-диагностическая лаборатория', 12, ago(10), 'С-АБ-1234568/2025', 'pass', 1,
      'Петров А.В.', 'Лаб. 201, шкаф 3', '']);

    await pool.query(insPip, ['P-003', 'GT2023005', 'Gilson', 'Pipetman L', '5000', 'Коагулогический отдел',
      'Клинико-диагностическая лаборатория', 6, ago(7), 'С-АБ-1234569/2025', 'pass', 1,
      'Иванова М.С.', 'Лаб. 105', 'Требует внеочередной проверки']);

    await pool.query(insPip, ['P-004', 'BT2022003', 'Biohit', 'mLINE', '200', 'Экспресс отдел',
      'Экспресс-лаборатория', 12, ago(14), 'С-АБ-9876546/2024', 'pass', 1,
      'Сидорова Е.К.', 'Лаб. 302', '']);

    await pool.query(insPip, ['P-005', 'TR2024008', 'Thermo', 'Finnpipette F2', '20', 'Серологический отдел',
      'Микробиологическая лаборатория', 12, ago(2), 'С-АБ-1234570/2025', 'pass', 0,
      'Петров А.В.', 'Склад', 'В резерве']);

    // История поверок
    const insHist = `INSERT INTO calibration_history (pipette_id, "date", cert, result, org, note)
                     VALUES ($1,$2,$3,$4,$5,$6)`;
    await pool.query(insHist, ['P-001', ago(23), 'С-АБ-9876543/2024', 'pass', 'ФБУ Красноярский ЦСМ', 'Годна']);
    await pool.query(insHist, ['P-001', ago(11), 'С-АБ-1234567/2025', 'pass', 'ФБУ Красноярский ЦСМ', 'Годна']);
    await pool.query(insHist, ['P-003', ago(13), 'С-АБ-9876545/2024', 'fail', 'ФБУ Красноярский ЦСМ', 'Брак']);
    await pool.query(insHist, ['P-003', ago(7),  'С-АБ-1234569/2025', 'pass', 'ФБУ Красноярский ЦСМ', 'После ремонта']);
  }

  // --- Фильтры по умолчанию ---
  const { rows: filc } = await pool.query('SELECT COUNT(*)::int AS c FROM filter_config');
  if (filc[0].c === 0) {
    const insF = `INSERT INTO filter_config
      (id, label, type, field_id, enabled, options_source, filter_order)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`;

    await pool.query(insF, ['status',       'Статус',         'select',      'status',           1, 'status_list', 1]);
    await pool.query(insF, ['subdivision',  'Подразделение',  'select',      'subdivision',      1, 'subdivisions', 2]);
    await pool.query(insF, ['department',   'Отдел',          'select',      'department',       1, 'departments', 3]);
    await pool.query(insF, ['responsible',  'Ответственный',  'text',        'responsible',      1, '',            4]);
    await pool.query(insF, ['model',        'Модель',         'text',        'model',            1, '',            5]);
    await pool.query(insF, ['manufacturer', 'Производитель',  'text',        'manufacturer',     1, '',            6]);
    await pool.query(insF, ['active',       'Активность',     'select',      'active',           1, 'active_list', 7]);
    await pool.query(insF, ['calPeriod',    'Дата поверки',   'date-period', 'last_calibration', 1, '',            8]);
  }
}

module.exports = { query, getConnection, pool, initSchema };
