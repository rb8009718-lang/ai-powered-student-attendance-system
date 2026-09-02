# AI Attendance Ledger — Full Stack

## Stack
- Frontend: HTML/CSS/JavaScript + face-api.js
- Backend: Node.js + Express
- Database: SQLite (`better-sqlite3`)
- Authentication: JWT
- Persistence: real database file (`attendance.db`)

## Run in VS Code

1. Install Node.js 18+.
2. Open this folder in VS Code.
3. Open Terminal.
4. Run:

```bash
npm install
npm start
```

5. Open `http://localhost:3000`.

For development:

```bash
npm run dev
```

## Important
- The first Teacher login can create a teacher account.
- Teacher password is stored in this demo as plain text. For production, replace it with bcrypt/argon2 hashing and environment-based secrets.
- Student enrollment now requires a PIN. Students log in using Roll Number + PIN.
- Attendance, students, subjects and marks are stored in SQLite and survive browser refreshes/restarts.
- Face descriptors are stored as JSON in SQLite. Camera/model loading still requires browser camera permission and an internet connection for the CDN model files.

## Project structure

```
ai-attendance-fullstack/
├── public/
│   └── index.html
├── package.json
├── server.js
└── attendance.db   # created automatically after first run
```

## API overview

- `POST /api/auth/teacher/register`
- `POST /api/auth/teacher/login`
- `POST /api/auth/student/login`
- `GET /api/bootstrap`
- `POST /api/subjects`
- `DELETE /api/subjects/:id`
- `POST /api/students`
- `DELETE /api/students/:id`
- `PUT /api/attendance`
- `PUT /api/marks`
- `GET /api/health`
