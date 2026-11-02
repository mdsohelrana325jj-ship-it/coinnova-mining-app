# CoinNova Telegram Mining App

CoinNova is a Telegram Mini App starter project with a mobile-friendly
mining points panel, referral information, daily rewards, tasks,
withdrawal requests, and an admin panel.

## Requirements

- Node.js 20 or newer
- A Telegram bot created with @BotFather
- A Render Web Service or another Node.js hosting provider
- Persistent storage for the SQLite database

## Project Structure

    coinnova-mining-app/
    ├── package.json
    ├── server.js
    ├── README.md
    ├── .env.example
    └── public/
        ├── index.html
        └── Admin.html

## Install

Run:

    npm install
    npm start

## Environment Variables

Configure these variables in your hosting dashboard:

- NODE_ENV=production
- APP_URL=https://YOUR-SERVICE.onrender.com
- BOT_TOKEN=your_telegram_bot_token
- BOT_USERNAME=your_bot_username_without_at_sign
- ADMIN_PASSWORD=your_strong_admin_password
- SESSION_SECRET=a_random_secret_of_at_least_32_characters
- DB_PATH=/var/data/coinnova.sqlite

Attach persistent storage mounted at `/var/data` when using the
database path above.

## Pages

- User Panel: /
- Admin Panel: /admin
- Health Check: /api/health

## Telegram Mini App

Configure the HTTPS application URL with BotFather.

The user panel authenticates using `Telegram.WebApp.initData`.
The backend verifies Telegram's signature. Do not trust
`initDataUnsafe` as an authentication credential.

## Important

Mining rewards in this starter project are in-app points, not
real cryptocurrency. Withdrawal requests are stored for admin
review; this project does not automatically transfer money or
cryptocurrency.

Task claims are not proof that an external task was completed.
Add verification before using rewards with real monetary value.

Before public launch, review authentication, rate limits, anti-abuse
controls, backups, privacy, and payment-provider integration.
