# Better Auth Bot

一个适用于 Better Auth 1.7.26 的 Bot 身份插件。Bot 是 `kind = BOT` 的 User，创建者可以是人或另一个 Bot。宿主应用决定谁有权创建、查看、停用 Bot，以及每把凭证能访问哪些资源。

## 注册插件

```ts
import { apiKey } from '@better-auth/api-key';
import { bot } from '@bubai/better-auth-bot';
import {
  botApiKeyConfig,
  botCredentials,
} from '@bubai/better-auth-bot/credentials';
import { betterAuth } from 'better-auth';

const auth = betterAuth({
  ...databaseAndAuthOptions,
  plugins: [bot(), apiKey([botApiKeyConfig])],
});

const identity = await auth.api.createBotUser({
  body: {
    createdByUserId: authorizedCreator.id,
    name: 'Team reader',
    email: 'team-reader@bots.example.com',
  },
});

const credentials = botCredentials(auth.api);
const issued = await credentials.issueBotKey(identity.id, {
  expiresIn: 30 * 86400,
  permissions: { team: ['read'] },
});
const principal = await credentials.verifyBotKey(issued.key, {
  team: ['read'],
});
```

已有 API Key 配置的应用把 `botApiKeyConfig` 加入同一个 `apiKey([...])` 实例，沿用当前 Prisma 模型映射。`bot()` 本身可以独立安装。Key 由官方 API Key 插件生成、哈希和校验。

## 服务端方法和 HTTP 接口

| 方法                       | 参数                                                     | 结果                                                                                    |
| -------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `auth.api.createBotUser`   | `body: { id?, createdByUserId, name, email }`            | 创建 Bot User。服务端可传入已有业务 ID。                                                |
| `auth.api.getBotUser`      | `query: { userId }`                                      | 返回 Bot User，包括创建者和停用时间。普通用户或未知 ID 返回 `404`。                     |
| `auth.api.disableBotUser`  | `body: { userId }`                                       | 停用 Bot，并保留身份供查询。                                                            |
| `credentials.issueBotKey`  | `userId, { name?, expiresIn?, permissions?, metadata? }` | 返回 `{ keyId, key, expiresAt }`。调用方只在签发时收到明文。                            |
| `credentials.verifyBotKey` | `key, permissions?`                                      | 返回 `{ keyId, userId, permissions, metadata }`，或 `null`。停用后旧 Key 不能通过校验。 |
| `credentials.revokeBotKey` | `userId, keyId`                                          | 停用属于该 Bot 的 Key。                                                                 |

身份接口默认只允许通过 `auth.api` 在服务端调用。需要 HTTP 时，给 `bot({ authorize })` 提供授权回调。回调接收原始请求和操作信息，校验凭证与资源权限后返回 `{ userId }`，拒绝时返回 `null`。创建者由授权结果提供。以下路径相对于 Better Auth base path。

| HTTP 接口           | 输入              |
| ------------------- | ----------------- |
| `POST /bot/create`  | `{ name, email }` |
| `GET /bot/get`      | `?userId=...`     |
| `POST /bot/disable` | `{ userId }`      |

Bot 使用机器凭证。插件在 Better Auth 的会话与第三方账户写入边界校验身份类型。应用的机器接口通过 `verifyBotKey` 获得身份，再执行资源级授权；把 Key 交给调用者的接口应设置 `Cache-Control: no-store`。

## Prisma

[PostgreSQL 参考 schema](prisma/schema.prisma) 包含 Better Auth 核心表和官方 API Key 表。合入既有数据库时，只需将 `kind`、`botCreatedByUserId`、`botDisabledAt` 与创建者自关联加到现有 `User` 模型，沿用已有模型、表名映射和其他插件字段。`botCreatedByUserId` 表示创建事实，管理权由应用决定。

## Bubai 接入位置

`@bubai/auth` 可以安装插件并合并 Key 配置。`BotService` 用事务绑定的 `authFor(tx).api.createBotUser(...)` 创建 Bot User，再用返回的 `User.id` 写入业务 `Bot`。Bubai 的 Team 授权、宿主校验、Relay 取票和审计留在共享业务服务中。Nest 和 Cloudflare 调用同一个服务。
