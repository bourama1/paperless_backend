# Commit Style

Use **conventional commits with emojis** exclusively:

```
<type>: <emoji> <description>
```

| Type     | Emoji   | Usage                          |
|----------|---------|--------------------------------|
| `feat`   | :sparkles: | New feature                 |
| `fix`    | :bug:      | Bug fix                     |
| `refactor` | :recycle: | Code refactoring           |
| `docs`   | :memo:     | Documentation               |
| `style`  | :lipstick: | UI/style changes            |
| `chore`  | :wrench:   | Build/tooling               |
| `test`   | :test_tube: | Tests                      |
| `perf`   | :zap:      | Performance                 |
| `ci`     | :green_heart: | CI/CD                   |

**Examples:**
- `feat: :sparkles: add user authentication`
- `fix: :bug: handle null pointer in login flow`
- `refactor: :recycle: extract parseAddress helper`
- `chore: :wrench: add build-exe script`

## Rules
- Never commit in any other style.
- Keep descriptions concise, imperative mood.
- If no clear single type fits, use `chore`.
- Scope is optional: `feat(api): :sparkles: add health endpoint`
