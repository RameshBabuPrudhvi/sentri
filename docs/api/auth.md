# Authentication API

## Register

```
POST /api/auth/register
```

**Body:**
```json
{
  "name": "Ada Lovelace",
  "email": "ada@example.com",
  "password": "min8chars"
}
```

**Response:** `201 Created`
```json
{ "message": "Account created successfully." }
```

## Sign In

```
POST /api/auth/login
```

**Body:**
```json
{
  "email": "ada@example.com",
  "password": "min8chars"
}
```

**Response:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": "uuid",
    "name": "Ada Lovelace",
    "email": "ada@example.com",
    "role": "user",
    "avatar": null
  }
}
```

Rate limited to **10 attempts per IP per 15 minutes**.

## Sign Out

```
POST /api/auth/logout
```

Requires `Authorization: Bearer <token>`. Revokes the token server-side.

## Get Current User

```
GET /api/auth/me
```

Requires `Authorization: Bearer <token>`.

## OAuth — GitHub

```
GET /api/auth/github/callback?code=<code>
```

Exchanges a GitHub OAuth code for a user profile and JWT. Requires `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` env vars on the server.

## OAuth — Google

```
GET /api/auth/google/callback?code=<code>
```

Exchanges a Google OAuth code for a user profile and JWT. Requires `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` env vars on the server.

## Token Format

JWTs are signed with HS256 and expire after **8 hours**. Payload:

```json
{
  "sub": "user-uuid",
  "email": "ada@example.com",
  "role": "user",
  "jti": "unique-token-id",
  "iat": 1700000000,
  "exp": 1700028800
}
```
