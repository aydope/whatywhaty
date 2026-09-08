# whatywahty

A Twitter-like social messaging app for real-time conversations and posts.

## Features
- User authentication & profiles
- Posts, comments & likes
- Real-time messaging via WebSockets
- Notifications
- Role-based access control (RBAC)
- Redis caching

## Tech Stack
- **Backend:** Node.js, Fastify
- **Database:** MongoDB (via plugin)
- **Cache:** Redis
- **Realtime:** Socket.io
- **Views:** EJS

## Quick Start

```bash
# Install dependencies
npm install

# Set up environment variables
cp .env.example .env

# Run in development
npm run start:dev

# Run in production
npm start
```

## Project Structure

```bash
src/
├── models/       # Database models
├── plugins/      # Auth, DB, RBAC, Redis, Socket
├── routes/       # API endpoints
├── services/     # Business logic
├── validators/   # Input validation
└── views/        # EJS templates
```

## License

```bash
MIT
```