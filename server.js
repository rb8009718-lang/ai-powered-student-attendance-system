const express = require("express");
const cors = require("cors");
const path = require("path");
const Database = require("better-sqlite3");
const jwt = require("jsonwebtoken");

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret-in-production";

const db = new Database(path.join(__dirname, "attendance.db"));
db.pragma("foreign_keys = ON");
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS teachers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  password TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS subjects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  teacher_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(name, teacher_id),
  FOREIGN KEY(teacher_id) REFERENCES teachers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  roll TEXT NOT NULL UNIQUE,
  pin TEXT NOT NULL,
  face_descriptor TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS student_subjects (
  student_id INTEGER NOT NULL,
  subject_id INTEGER NOT NULL,
  PRIMARY KEY(student_id, subject_id),
  FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE,
  FOREIGN KEY(subject_id) REFERENCES subjects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  subject_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('present','absent')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(student_id, subject_id, date),
  FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE,
  FOREIGN KEY(subject_id) REFERENCES subjects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS marks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  subject_id INTEGER NOT NULL,
  score REAL NOT NULL CHECK(score >= 0 AND score <= 100),
  UNIQUE(student_id, subject_id),
  FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE,
  FOREIGN KEY(subject_id) REFERENCES subjects(id) ON DELETE CASCADE
);
`);

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

function sign(user) {
  return jwt.sign(user, JWT_SECRET, { expiresIn: "12h" });
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Authentication required." });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Session expired. Please log in again." });
  }
}

function teacherOnly(req, res, next) {
  if (req.user.role !== "teacher") return res.status(403).json({ error: "Teacher access required." });
  next();
}

function teacherOwnsSubject(teacherId, subjectId) {
  return !!db.prepare("SELECT id FROM subjects WHERE id=? AND teacher_id=?").get(subjectId, teacherId);
}

function getBootstrap() {
  const subjects = db.prepare("SELECT id,name,teacher_id AS teacherId FROM subjects ORDER BY name").all();
  const students = db.prepare(`
    SELECT id,name,roll,pin,face_descriptor AS faceDescriptor
    FROM students ORDER BY name
  `).all().map(s => ({
    ...s,
    faceDescriptor: s.faceDescriptor ? JSON.parse(s.faceDescriptor) : null,
    subjectIds: db.prepare("SELECT subject_id AS id FROM student_subjects WHERE student_id=?").all(s.id).map(x => x.id)
  }));
  const attendance = db.prepare(`
    SELECT id,student_id AS studentId,subject_id AS subjectId,date,status
    FROM attendance ORDER BY date DESC, id DESC
  `).all();
  const marks = db.prepare(`
    SELECT id,student_id AS studentId,subject_id AS subjectId,score
    FROM marks
  `).all();
  return { subjects, students, attendance, marks };
}

app.post("/api/auth/teacher/register", (req, res) => {
  const { name, password } = req.body;
  if (!name?.trim() || !password || password.length < 6)
    return res.status(400).json({ error: "Name and a password of at least 6 characters are required." });

  const existing = db.prepare("SELECT id FROM teachers WHERE lower(name)=lower(?)").get(name.trim());
  if (existing) return res.status(409).json({ error: "A teacher with this name already exists." });

  const info = db.prepare("INSERT INTO teachers(name,password) VALUES(?,?)").run(name.trim(), password);
  const user = { id: Number(info.lastInsertRowid), name: name.trim(), role: "teacher" };
  res.json({ token: sign(user), user });
});

app.post("/api/auth/teacher/login", (req, res) => {
  const { name, password } = req.body;
  const teacher = db.prepare("SELECT id,name,password FROM teachers WHERE lower(name)=lower(?)").get((name || "").trim());
  if (!teacher || teacher.password !== password)
    return res.status(401).json({ error: "Invalid teacher name or password." });

  const user = { id: teacher.id, name: teacher.name, role: "teacher" };
  res.json({ token: sign(user), user });
});

app.post("/api/auth/student/login", (req, res) => {
  const { roll, pin } = req.body;
  const student = db.prepare("SELECT id,name,roll,pin FROM students WHERE lower(roll)=lower(?)").get((roll || "").trim());
  if (!student || student.pin !== pin)
    return res.status(401).json({ error: "Invalid roll number or PIN." });

  const user = { id: student.id, name: student.name, roll: student.roll, role: "student" };
  res.json({ token: sign(user), user });
});

app.get("/api/bootstrap", auth, (req, res) => {
  const data = getBootstrap();
  if (req.user.role === "teacher") {
    data.subjects = data.subjects.filter(s => s.teacherId === req.user.id);
    const allowed = new Set(data.subjects.map(s => s.id));
    data.students = data.students.filter(s => s.subjectIds.some(id => allowed.has(id)));
    data.students.forEach(s => s.subjectIds = s.subjectIds.filter(id => allowed.has(id)));
    data.attendance = data.attendance.filter(a => allowed.has(a.subjectId));
    data.marks = data.marks.filter(m => allowed.has(m.subjectId));
  } else {
    data.subjects = data.subjects.filter(s => {
      const row = db.prepare("SELECT 1 FROM student_subjects WHERE student_id=? AND subject_id=?").get(req.user.id, s.id);
      return !!row;
    });
    const allowed = new Set(data.subjects.map(s => s.id));
    data.students = data.students.filter(s => s.id === req.user.id);
    data.students.forEach(s => s.subjectIds = s.subjectIds.filter(id => allowed.has(id)));
    data.attendance = data.attendance.filter(a => a.studentId === req.user.id);
    data.marks = data.marks.filter(m => m.studentId === req.user.id);
  }
  res.json(data);
});

app.post("/api/subjects", auth, teacherOnly, (req, res) => {
  const name = String(req.body.name || "").trim().replace(/\s+/g, " ");
  if (!name) return res.status(400).json({ error: "Subject name is required." });
  try {
    const info = db.prepare("INSERT INTO subjects(name,teacher_id) VALUES(?,?)").run(name, req.user.id);
    res.json({ id: Number(info.lastInsertRowid), name, teacherId: req.user.id });
  } catch {
    res.status(409).json({ error: "That subject already exists for this teacher." });
  }
});

app.delete("/api/subjects/:id", auth, teacherOnly, (req, res) => {
  const id = Number(req.params.id);
  if (!teacherOwnsSubject(req.user.id, id)) return res.status(404).json({ error: "Subject not found." });
  db.prepare("DELETE FROM subjects WHERE id=?").run(id);
  res.json({ ok: true });
});

app.post("/api/students", auth, teacherOnly, (req, res) => {
  const { name, roll, pin, subjectIds, faceDescriptor } = req.body;
  if (!name?.trim() || !roll?.trim() || !pin || pin.length < 4)
    return res.status(400).json({ error: "Name, roll number and a 4+ digit PIN are required." });

  const ids = [...new Set((subjectIds || []).map(Number))];
  if (!ids.length) return res.status(400).json({ error: "Select at least one subject." });
  if (ids.some(id => !teacherOwnsSubject(req.user.id, id)))
    return res.status(403).json({ error: "Invalid subject selection." });

  try {
    const tx = db.transaction(() => {
      const info = db.prepare(`
        INSERT INTO students(name,roll,pin,face_descriptor) VALUES(?,?,?,?)
      `).run(name.trim(), roll.trim().replace(/\s+/g, ""), pin, faceDescriptor ? JSON.stringify(faceDescriptor) : null);
      const studentId = Number(info.lastInsertRowid);
      const ins = db.prepare("INSERT INTO student_subjects(student_id,subject_id) VALUES(?,?)");
      ids.forEach(id => ins.run(studentId, id));
      return studentId;
    });
    const id = tx();
    res.json({ id, name: name.trim(), roll: roll.trim(), subjectIds: ids, faceDescriptor: faceDescriptor || null });
  } catch (e) {
    res.status(409).json({ error: "That roll number is already enrolled." });
  }
});

app.delete("/api/students/:id", auth, teacherOnly, (req, res) => {
  const id = Number(req.params.id);
  const student = db.prepare("SELECT id FROM students WHERE id=?").get(id);
  if (!student) return res.status(404).json({ error: "Student not found." });
  const hasOwnedSubject = db.prepare(`
    SELECT 1 FROM student_subjects ss
    JOIN subjects s ON s.id=ss.subject_id
    WHERE ss.student_id=? AND s.teacher_id=?
  `).get(id, req.user.id);
  if (!hasOwnedSubject) return res.status(403).json({ error: "You cannot remove this student." });
  db.prepare("DELETE FROM students WHERE id=?").run(id);
  res.json({ ok: true });
});

app.put("/api/attendance", auth, teacherOnly, (req, res) => {
  const { subjectId, date, records } = req.body;
  if (!teacherOwnsSubject(req.user.id, Number(subjectId)))
    return res.status(403).json({ error: "Invalid subject." });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !Array.isArray(records))
    return res.status(400).json({ error: "Invalid attendance payload." });

  const roster = db.prepare(`
    SELECT ss.student_id AS studentId
    FROM student_subjects ss
    WHERE ss.subject_id=?
  `).all(Number(subjectId)).map(x => x.studentId);

  const recordMap = new Map(records.map(r => [Number(r.studentId), r.status === "present" ? "present" : "absent"]));
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM attendance WHERE subject_id=? AND date=?").run(Number(subjectId), date);
    const ins = db.prepare(`
      INSERT INTO attendance(student_id,subject_id,date,status) VALUES(?,?,?,?)
    `);
    roster.forEach(studentId => ins.run(studentId, Number(subjectId), date, recordMap.get(studentId) || "absent"));
  });
  tx();
  res.json({ ok: true, count: roster.length });
});

app.put("/api/marks", auth, teacherOnly, (req, res) => {
  const { studentId, subjectId, score } = req.body;
  if (!teacherOwnsSubject(req.user.id, Number(subjectId)))
    return res.status(403).json({ error: "Invalid subject." });
  const enrolled = db.prepare(`
    SELECT 1 FROM student_subjects WHERE student_id=? AND subject_id=?
  `).get(Number(studentId), Number(subjectId));
  if (!enrolled) return res.status(400).json({ error: "Student is not enrolled in this subject." });

  const n = Number(score);
  if (!Number.isFinite(n) || n < 0 || n > 100)
    return res.status(400).json({ error: "Marks must be between 0 and 100." });

  db.prepare(`
    INSERT INTO marks(student_id,subject_id,score) VALUES(?,?,?)
    ON CONFLICT(student_id,subject_id) DO UPDATE SET score=excluded.score
  `).run(Number(studentId), Number(subjectId), n);
  res.json({ ok: true });
});

app.get("/api/health", (req, res) => res.json({ ok: true, database: "sqlite", time: new Date().toISOString() }));

app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log(`AI Attendance Ledger running at http://localhost:${PORT}`);
});
