/**
 * The core server that runs on a Cloudflare worker.
 */

import { AutoRouter } from 'itty-router';
import {
  InteractionResponseType,
  InteractionType,
  verifyKey,
} from 'discord-interactions';
import { STATUS_COMMAND } from './commands.js';
import { InteractionResponseFlags } from 'discord-interactions';

// const DEFAULT_REVIEW_COUNT = 2;
// let activePullRequests = {}

class JsonResponse extends Response {
  constructor(body, init) {
    const jsonBody = JSON.stringify(body);
    init = init || {
      headers: {
        'content-type': 'application/json;charset=UTF-8',
      },
    };
    super(jsonBody, init);
  }
}

const router = AutoRouter();

/**
 * A simple :wave: hello page to verify the worker is working.
 */
router.get('/', (request, env) => {
  return new Response(`👋 ${env.DISCORD_APPLICATION_ID}`);
});

/**
 * Main route for all requests sent from Discord.  All incoming messages will
 * include a JSON payload described here:
 * https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object
 */
router.post('/', async (request, env) => {
  const { isValid, interaction } = await server.verifyDiscordRequest(
    request,
    env,
  );

  if (!isValid || !interaction) {
    return new Response('Bad request signature.', { status: 401 });
  }

  if (interaction.type === InteractionType.PING) {
    // The `PING` message is used during the initial webhook handshake, and is
    // required to configure the webhook in the developer portal.
    return new JsonResponse({
      type: InteractionResponseType.PONG,
    });
  }

  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    // Most user commands will come as `APPLICATION_COMMAND`.
    switch (interaction.data.name.toLowerCase()) {
      case STATUS_COMMAND.name.toLowerCase(): {
        return new JsonResponse({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: `I'm currently online.`,
          },
        });
      }
      case SET_COMMAND.name.toLowerCase(): {
        const guildId = interaction.channel.guild_id;
        const channelId = interaction.channel.id;
        await env.CHANNEL_ID.put(`${guildId}`, `${channelId}`);

        return new JsonResponse({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: `Channel has been set to https://discord.com/channels/${guildId}/${channelId}`,
          },
        });
      }
      case CHECK_COMMAND.name.toLowerCase(): {
        const guildId = interaction.channel.guild_id;
        const channelId = await env.CHANNEL_ID.get(guildId);

        return new JsonResponse({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: (guildId && channelId) ?
              `Channel is currently set to https://discord.com/channels/${guildId}/${channelId}` :
              `Channel has not been set.\n` +
              `Use /set within a channel to set it.`,
          },
        });
      }
      default:
        return new JsonResponse({ error: 'Unknown Type' }, { status: 400 });
    }
  }

  console.error('Unknown Type');
  return new JsonResponse({ error: 'Unknown Type' }, { status: 400 });
});

router.post('/webhook', async (request, env) => {
  const githubEvent = request.headers.get('x-github-event');
  const body = await request.json();

  const response = new Response('Accepted', { status: 202 });

  let message;
  if (githubEvent === 'pull_request') {
    const action = body.action;
    if (action === 'opened' || action === 'reopened') {
      // activePullRequests[body.pull_request.id] = { count: DEFAULT_REVIEW_COUNT };
      message = `${body.pull_request.user.login} has created a pull request from ${body.pull_request.head.ref} to ${body.pull_request.base.ref}\n` +
        `Please review this at ${body.pull_request.html_url}`;
    } else if (action === 'closed') {
      message = `[${body.pull_request.title}](<${body.pull_request.html_url}>) was closed by ${body.pull_request.user.login}`;
    }
    // DEBUGGING/TESTING
    // else {
    //   message = `Unhandled action for issues: ${action}`;
    // }
  }
  // else if (githubEvent === 'pull_request_review') {
  //   const action = body.action;
  //   if (action === 'submitted' && body.review.state === 'approved') {
  //     if (activePullRequests[body.pull_request.id] ?? false) {
  //       activePullRequests[body.pull_request.id].count -= 1;

  //       if (activePullRequests[body.pull_request.id].count === 0) {
  //         message = `All reviews for [${body.pull_request.title}](<${body.pull_request.html_url}>) have been approved!`;
  //         delete activePullRequests[body.pull_request.id];
  //       } else {
  //         message = `A review has been approved for [${body.pull_request.title}](<${body.pull_request.html_url}>). ` +
  //           `${activePullRequests[body.pull_request.id].count} review(s) remaining.`;
  //       }
  //     }
  //   }
  // DEBUGGING/TESTING
  // else {
  //   message = `Unhandled action for issues: ${action}`;
  // }
  // }
  // DEBUGGING/TESTING
  // else if (githubEvent === 'ping') {
  //   message = 'GitHub sent the ping event';
  // } else {
  //   message = `Unhandled event: ${githubEvent}`;
  // }
  const DISCORD_GUILD_IDS = await env.CHANNEL_ID.list()
    .then((array) => {
      return array.keys();
    });

  if (message) {
    try {
      await Promise.all(DISCORD_GUILD_IDS.map((guildId) => {
        return env.CHANNEL_ID.get(`${guildId}`).then((channelId) => {
          if (channelId) {
            return fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bot ${env.DISCORD_TOKEN}`,
              },
              body: JSON.stringify({
                content: message,
              }),
            });
          } else {
            console.error(`No channel ID found for guild ${guildId}`);
          }
        });
      }));
    } catch (err) {
      console.error('Failed to send Discord message:', err);
    }
  }

  return response;
});

router.all('*', () => new Response('Not Found.', { status: 404 }));

async function verifyDiscordRequest(request, env) {
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  const body = await request.text();
  const isValidRequest =
    signature &&
    timestamp &&
    (await verifyKey(body, signature, timestamp, env.DISCORD_PUBLIC_KEY));
  if (!isValidRequest) {
    return { isValid: false };
  }

  return { interaction: JSON.parse(body), isValid: true };
}

const server = {
  verifyDiscordRequest,
  fetch: router.fetch,
};

export default server;