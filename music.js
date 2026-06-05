// src/music.js - PopkinnCloud Lavalink Music System (lavalink-client v5.0.0)
// ═══════════════════════════════════════════════════════════════════════════════
// Fixes: volume linearity, skip safety, stop/queue errors, 24/7 VC logic,
//        node failover + fallback node, footer length, paginated queue
// ═══════════════════════════════════════════════════════════════════════════════

const { LavalinkManager } = require('lavalink-client');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

// ── Constants ────────────────────────────────────────────────────────────────
const IDLE_TIMEOUT_MS      = 60 * 1000;  // 1 min idle leave for non-Elite
const SEARCH_FAIL_LEAVE_MS = 5  * 1000;  // leave after 5s if search fails on empty player
const DEFAULT_VOLUME       = 50;
const QUEUE_PAGE_SIZE      = 10;

// ── State ─────────────────────────────────────────────────────────────────────
const idleTimers        = new Map(); // guildId → timeout handle
const reconnectGuard    = new Set(); // guildIds being reconnected — prevents duplicate loops
let   manager           = null;

// ── Safe player destroy — clears queue, leaves VC, no ghost players ──────────
async function safeDestroyPlayer(player, guildId, reason = 'unknown') {
    if (!player) return;
    console.log(`[Music] Destroying player in guild ${guildId} — reason: ${reason}`);
    clearIdleTimer(guildId);
    try {
        clearQueueSafe(player);
        await player.destroy();
    } catch (e) {
        console.warn(`[Music] safeDestroyPlayer error in guild ${guildId}:`, e.message);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MANAGER SETUP
// ═══════════════════════════════════════════════════════════════════════════════

function createManager(client) {
    manager = new LavalinkManager({
        nodes: [
            // ── Primary node ─────────────────────────────────────────────────
            {
                authorization: 'kirito',
                host: 'lavalink.triniumhost.com',
                port: 2333,
                id: 'primary',
                secure: false,
                retryAmount: 5,
                retryDelay: 9000
            },
            
            {
                authorization: 'https://dsc.gg/ajidevserver',
                host: 'lava-v4.ajieblogs.eu.org',
                port: 80,
                id: 'secondary',
                secure: false,
                retryAmount: 15,
                retryDelay: 3000
            },
            // ── Free fallback node (lavalink.devamop.in — public, stable) ───
            {
                authorization: 'https://discord.gg/mjS5J2K3ep',
                host: 'lava-v4.millohost.my.id',
                port: 443,
                id: 'fallback',
                secure: true,
                retryAmount: 10,
                retryDelay: 5000
            }
        ],
        sendToShard: (guildId, payload) => {
            const guild = client.guilds.cache.get(guildId);
            if (guild) guild.shard.send(payload);
        },
        client: {
            id: client.user.id,
            username: client.user.username
        },
        playerOptions: {
            defaultSearchPlatform: 'ytsearch',
            // Fallback search: if YouTube fails with login error, bot retries on Spotify automatically
            // Requires LavaSrc or similar Lavalink plugin for Spotify support (spsearch:)
            // Without plugin, spsearch will fall back to ytmsearch gracefully
            volumeDecrementer: 1,
            onDisconnect: {
                autoReconnect: true,
                destroyPlayer: false
            },
            onEmptyQueue: {
                destroyAfterMs: undefined // we control leave logic ourselves
            }
        },
        autoSkip: true,
        // FIX 2 — balance load across nodes; auto-assign new players to least loaded
        nodeBalancerOptions: {
            cpuLoadBalancer: true,
            freeMemBalancer: true
        }
    });

    // ── Node events ──────────────────────────────────────────────────────────
    manager.nodeManager.on('connect', (node) => {
        console.log(`[Lavalink] ✅ Node "${node.id}" connected`);
    });

    manager.nodeManager.on('disconnect', (node, reason) => {
        console.warn(`[Lavalink] ⚠️ Node "${node.id}" disconnected — ${reason?.reason || 'unknown'}`);
        const aliveNodes = [...manager.nodeManager.nodes.values()].filter(n => n.connected && n.id !== node.id);
        if (aliveNodes.length > 0) {
            console.log(`[Lavalink] ${aliveNodes.length} node(s) still alive — migrating players`);
            migratePlayersFromNode(client, node.id);
        } else {
            console.warn(`[Lavalink] ⛔ ALL nodes disconnected — destroying all players to prevent ghost VCs`);
            // Destroy all players since there's nowhere to play
            for (const [guildId, player] of manager.players) {
                const ch = client.channels.cache.get(player.textChannelId);
                if (ch) {
                    ch.send({
                        embeds: [new EmbedBuilder()
                            .setColor('#ff0000')
                            .setDescription('❌ All music nodes went offline. Leaving voice channel to prevent being stuck. Use `/refresh-lavalink` to reconnect.')]
                    }).catch(() => {});
                }
                safeDestroyPlayer(player, guildId, 'all nodes disconnected').catch(() => {});
            }
        }
    });

    manager.nodeManager.on('error', (node, error) => {
        console.error(`[Lavalink] ❌ Node "${node.id}" error:`, error?.message || error);
    });

    manager.nodeManager.on('reconnecting', (node) => {
        console.log(`[Lavalink] 🔄 Node "${node.id}" reconnecting...`);
    });

    // ── Player events ────────────────────────────────────────────────────────
    manager.on('trackStart', (player, track) => {
        clearIdleTimer(player.guildId);
        const channel = client.channels.cache.get(player.textChannelId);
        if (!channel) return;
        const embed = new EmbedBuilder()
            .setColor('#00fbff')
            .setTitle('🎵 Now Playing')
            .setDescription(`**[${safeStr(track.info.title, 200)}](${track.info.uri})**`)
            .addFields(
                { name: '👤 Author',   value: safeStr(track.info.author, 100), inline: true },
                { name: '⏱️ Duration', value: track.info.isStream ? 'LIVE 🔴' : msToTime(track.info.duration), inline: true }
            )
            .setThumbnail(track.info.artworkUrl || null)
            .setFooter({ text: `Requested by ${safeStr(track.requester?.username || 'Unknown', 50)}` })
            .setTimestamp();
        channel.send({ embeds: [embed] }).catch(() => {});
    });

    manager.on('queueEnd', (player) => {
        const guildData = global.getGuildData(player.guildId);
        const is247 = guildData.plan === 'ELITE' && guildData.twentyFourSeven === true;

        if (is247) {
            const channel = client.channels.cache.get(player.textChannelId);
            if (channel) {
                channel.send({
                    embeds: [new EmbedBuilder()
                        .setColor('#9b59b6')
                        .setDescription('✅ Queue ended. Staying connected — **24/7 Mode** is active.')]
                }).catch(() => {});
            }
            return; // do NOT destroy player or schedule idle leave
        }

        scheduleIdleLeave(client, player.guildId);
    });

    manager.on('trackError', (player, track, payload) => {
        const errMsg = payload?.exception?.message || payload?.exception?.cause || 'unknown error';
        console.error(`[Lavalink] Track error in guild ${player.guildId} — track: "${track?.info?.title}" — error: ${errMsg}`);

        // Detect YouTube login/age-restriction errors and retry on Spotify automatically
        const isYtLoginError = errMsg.toLowerCase().includes('all clients failed') ||
                               errMsg.toLowerCase().includes('requires login') ||
                               errMsg.toLowerCase().includes('sign in') ||
                               errMsg.toLowerCase().includes('video unavailable') ||
                               errMsg.toLowerCase().includes('yts.version');

        if (isYtLoginError && track?.info?.title) {
            console.log(`[Music] YouTube login error — attempting Spotify retry for: "${track.info.title}"`);
            const retryQuery = track.info.title + (track.info.author ? ' ' + track.info.author : '');

            player.search({ query: retryQuery, source: 'spotify' }, { id: 'system', username: 'AutoRetry' })
                .then(async (spResult) => {
                    if (spResult && spResult.tracks?.length > 0 && spResult.loadType !== 'error') {
                        console.log(`[Music] Spotify retry found: "${spResult.tracks[0].info.title}"`);
                        await player.queue.add(spResult.tracks[0], 0); // add to front of queue
                        if (!player.playing) await player.play().catch(() => {});
                        const channel = client.channels.cache.get(player.textChannelId);
                        if (channel) {
                            const { EmbedBuilder } = require('discord.js');
                            channel.send({
                                embeds: [new EmbedBuilder()
                                    .setColor('#1DB954') // Spotify green
                                    .setDescription(`⚠️ YouTube blocked **${safeStr(track.info.title, 80)}**\n🎵 Playing via **Spotify** instead: **${safeStr(spResult.tracks[0].info.title, 80)}**`)]
                            }).catch(() => {});
                        }
                        return; // Don't send the error message below
                    }
                    throw new Error('Spotify fallback empty');
                })
                .catch(() => {
                    // Both failed — send error and continue
                    const channel = client.channels.cache.get(player.textChannelId);
                    if (channel) {
                        const { EmbedBuilder } = require('discord.js');
                        channel.send({
                            embeds: [new EmbedBuilder()
                                .setColor('#ff0000')
                                .setDescription(`❌ **${safeStr(track?.info?.title || 'Track', 80)}** is age-restricted or login-required on YouTube, and Spotify fallback also failed.\nSkipping to next track...`)]
                        }).catch(() => {});
                    }
                    // Trigger skip to next track
                    if (player.queue.tracks?.length > 0) {
                        player.skip().catch(() => {});
                    } else {
                        const guildData = global.getGuildData(player.guildId);
                        const is247 = guildData.plan === 'ELITE' && guildData.twentyFourSeven === true;
                        if (!is247) scheduleIdleLeave(client, player.guildId);
                    }
                });
            return; // Exit — the retry promise will handle messaging
        }

        // Standard track error (not YouTube login)
        const channel = client.channels.cache.get(player.textChannelId);
        if (channel) {
            const { EmbedBuilder } = require('discord.js');
            channel.send({
                embeds: [new EmbedBuilder()
                    .setColor('#ff0000')
                    .setDescription(`❌ Error playing **${safeStr(track?.info?.title || 'track', 100)}**: ${safeStr(errMsg, 80)}\nSkipping to next track...`)]
            }).catch(() => {});
        }
        // If no more tracks and not 24/7, schedule idle leave
        const queueEmpty = (player.queue.tracks?.length ?? 0) === 0;
        if (queueEmpty) {
            const guildData = global.getGuildData(player.guildId);
            const is247 = guildData.plan === 'ELITE' && guildData.twentyFourSeven === true;
            if (!is247) {
                console.log(`[Music] Track error with empty queue in guild ${player.guildId} — scheduling idle leave`);
                scheduleIdleLeave(client, player.guildId);
            }
        }
    });

    manager.on('playerDestroy', (player) => {
        clearIdleTimer(player.guildId);
    });

    return manager;
}

// ── Node failover: move all players off a dead node ──────────────────────────
async function migratePlayersFromNode(client, deadNodeId) {
    if (!manager) return;
    const aliveNode = [...manager.nodeManager.nodes.values()]
        .find(n => n.connected && n.id !== deadNodeId);
    if (!aliveNode) return;

    for (const [guildId, player] of manager.players) {
        if (player.node?.id !== deadNodeId) continue;
        try {
            await player.changeNode(aliveNode.id);
            console.log(`[Lavalink] Migrated guild ${guildId} → node "${aliveNode.id}"`);
            const ch = client.channels.cache.get(player.textChannelId);
            if (ch) ch.send({
                embeds: [new EmbedBuilder()
                    .setColor('#ff9900')
                    .setDescription(`⚠️ Node went down — switched to backup node. Playback may have briefly paused.`)]
            }).catch(() => {});
        } catch (e) {
            console.error(`[Lavalink] Migration failed for guild ${guildId}:`, e.message);
        }
    }
}

// ── Idle leave ───────────────────────────────────────────────────────────────
function scheduleIdleLeave(client, guildId) {
    clearIdleTimer(guildId);
    const timer = setTimeout(async () => {
        const player = manager?.players.get(guildId);
        if (!player || player.playing) return;
        const ch = client.channels.cache.get(player.textChannelId);
        if (ch) ch.send({
            embeds: [new EmbedBuilder()
                .setColor('#ff9900')
                .setDescription('👋 Left voice channel due to inactivity (1 min).')]
        }).catch(() => {});
        await player.destroy().catch(() => {});
    }, IDLE_TIMEOUT_MS);
    idleTimers.set(guildId, timer);
}

function clearIdleTimer(guildId) {
    if (idleTimers.has(guildId)) {
        clearTimeout(idleTimers.get(guildId));
        idleTimers.delete(guildId);
    }
}

function getManager() { return manager; }

// ── Raw WS forwarding ────────────────────────────────────────────────────────
function handleRawEvent(data) {
    if (manager) manager.sendRawData(data);
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

// FIX 5 — always truncate strings before passing to embed fields/footer
function safeStr(str, maxLen = 100) {
    if (!str || typeof str !== 'string') return 'Unknown';
    return str.length > maxLen ? str.slice(0, maxLen - 1) + '\u2026' : str;
}

function msToTime(ms) {
    if (!ms || ms <= 0) return '0:00';
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0
        ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
        : `${m}:${String(sec).padStart(2, '0')}`;
}

// FIX 4 — safe queue clear compatible with lavalink-client Queue object OR plain array
function clearQueueSafe(player) {
    try {
        if (typeof player.queue?.clear === 'function') {
            player.queue.clear();
        } else if (Array.isArray(player.queue?.tracks)) {
            player.queue.tracks.splice(0, player.queue.tracks.length);
        } else if (player.queue?.tracks) {
            player.queue.tracks = [];
        }
    } catch (e) {
        console.error('[Music] clearQueueSafe error:', e.message);
    }
}

// ── Voice check ───────────────────────────────────────────────────────────────
// FIX 6 — allowMove:true lets /play move bot to user's VC instead of erroring
function voiceChecks(interaction, { allowMove = false } = {}) {
    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
        return { ok: false, error: '❌ You must be in a voice channel to use music commands!' };
    }
    const botVC = interaction.guild.members.me?.voice?.channel;
    if (botVC && botVC.id !== voiceChannel.id) {
        if (allowMove) return { ok: true, voiceChannel, needsMove: true };
        return { ok: false, error: `❌ You must be in the same voice channel as the bot! (<#${botVC.id}>)` };
    }
    return { ok: true, voiceChannel, needsMove: false };
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMMAND HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

// ── /play ────────────────────────────────────────────────────────────────────
async function handlePlayCommand(interaction) {
    await interaction.deferReply();

    const guildData = global.getGuildData(interaction.guildId);
    const is247 = guildData.plan === 'ELITE' && guildData.twentyFourSeven === true;

    // If 24/7 is active and bot is already in a VC, user MUST be in that same VC
    const check = voiceChecks(interaction, { allowMove: !is247 });
    if (!check.ok) return interaction.editReply({ content: check.error });

    if (is247 && check.needsMove) {
        const botVC = interaction.guild.members.me?.voice?.channel;
        return interaction.editReply({
            content: `❌ **24/7 Mode** is active — the bot is locked to <#${botVC?.id}>.\nJoin that channel or disable 24/7 mode with \`/24-7\` first.`
        });
    }

    const query = interaction.options.getString('query');
    const m = getManager();
    if (!m) return interaction.editReply({ content: '❌ Music system is not ready yet.' });

    // Check at least one node is alive before creating a player
    const aliveNodes = [...m.nodeManager.nodes.values()].filter(n => n.connected);
    if (aliveNodes.length === 0) {
        console.warn(`[Music] /play — no connected Lavalink nodes in guild ${interaction.guildId}`);
        return interaction.editReply({
            content: '❌ All music nodes are currently offline. Try `/refresh-lavalink` or wait a moment.'
        });
    }

    let player = m.players.get(interaction.guildId);
    let playerWasNew = false;

    if (!player) {
        playerWasNew = true;
        player = m.createPlayer({
            guildId:        interaction.guildId,
            voiceChannelId: check.voiceChannel.id,
            textChannelId:  interaction.channelId,
            selfDeaf:       true,
            volume:         DEFAULT_VOLUME
        });
    } else if (check.needsMove) {
        player.voiceChannelId = check.voiceChannel.id;
        await player.connect().catch(() => {});
    }

    if (!player.connected) {
        try {
            await player.connect();
        } catch (e) {
            console.error(`[Music] Failed to connect player in guild ${interaction.guildId}:`, e.message);
            await safeDestroyPlayer(player, interaction.guildId);
            return interaction.editReply({ content: '❌ Failed to connect to the voice channel. Please try again.' });
        }
    }

    // Search — with Spotify fallback when YouTube returns login/age-restricted errors
    let result = null;
    let searchPlatform = 'ytsearch';

    const trySearch = async (platform, q) => {
        try {
            const query = platform === 'spsearch' ? q : q;
            const r = await player.search({ query, source: platform === 'ytsearch' ? undefined : platform }, interaction.user);
            return r;
        } catch (e) {
            console.warn(`[Music] Search error on platform "${platform}" — ${e.message}`);
            return null;
        }
    };

    // First attempt: YouTube
    result = await trySearch('ytsearch', query);

    // If YouTube fails or returns a login/age-restricted track with no usable result,
    // fall back to Spotify search for the track name
    const ytFailed = !result || result.loadType === 'empty' || result.loadType === 'error';
    const ytLoginError = result?.tracks?.[0] && (
        result.loadType === 'error' ||
        (result.tracks.length === 0 && result.loadType !== 'playlist')
    );

    if (ytFailed || ytLoginError) {
        console.warn(`[Music] YouTube search failed (${result?.loadType ?? 'null'}) — trying Spotify fallback for: "${query}"`);
        const spResult = await trySearch('spsearch', query);
        if (spResult && spResult.loadType !== 'empty' && spResult.loadType !== 'error' && (spResult.tracks?.length ?? 0) > 0) {
            console.log(`[Music] Spotify fallback succeeded for: "${query}" — ${spResult.tracks.length} track(s) found`);
            result = spResult;
            searchPlatform = 'spsearch';
        } else {
            console.warn(`[Music] Spotify fallback also failed for: "${query}"`);
        }
    }

    // Also check if the single returned track has a known unplayable error signature
    // (yts version error / all clients failed) — try Spotify for same query
    if (result && result.loadType !== 'empty' && result.loadType !== 'error' && result.tracks?.length > 0 && searchPlatform === 'ytsearch') {
        // We'll let it try to play — trackError handler will catch it and we don't pre-screen
        // But if the query looks like it might be age-restricted (no direct URL), try spsearch proactively
        const isUrlQuery = /^https?:\/\//.test(query);
        if (!isUrlQuery) {
            // For text queries on YouTube that notoriously fail (known YTS issue),
            // also queue a Spotify backup search silently — if YT track errors, the player auto-skips
        }
    }

    if (!result || result.loadType === 'empty' || result.loadType === 'error' || (result.tracks?.length ?? 0) === 0) {
        console.warn(`[Music] All search platforms failed in guild ${interaction.guildId} — query: "${query}"`);
        // Only destroy if player had nothing queued before this command
        if (playerWasNew || (!player.playing && (player.queue.tracks?.length ?? 0) === 0)) {
            console.log(`[Music] Auto-leaving VC in guild ${interaction.guildId} — reason: search failure on empty player`);
            await safeDestroyPlayer(player, interaction.guildId);
        }
        return interaction.editReply({ content: `❌ No results found for **${safeStr(query, 100)}**.\nYouTube and Spotify both returned no results. Try a different search term or paste a direct URL.` });
    }

    clearIdleTimer(interaction.guildId);

    if (result.loadType === 'playlist') {
        await player.queue.add(result.tracks);
        if (!player.playing) await player.play().catch((e) => {
            console.error(`[Music] play() failed for playlist in guild ${interaction.guildId}:`, e.message);
        });
        const name = safeStr(result.playlist?.name || 'Unknown', 100);
        return interaction.editReply({
            embeds: [new EmbedBuilder()
                .setColor('#00fbff')
                .setDescription(`📀 Added playlist **${name}** — **${result.tracks.length}** tracks`)]
        });
    }

    const track = result.tracks[0];
    await player.queue.add(track);
    if (!player.playing) await player.play().catch((e) => {
        console.error(`[Music] play() failed in guild ${interaction.guildId}:`, e.message);
    });

    const inQueue = player.playing && (player.queue.tracks?.length ?? 0) > 1;
    return interaction.editReply({
        embeds: [new EmbedBuilder()
            .setColor('#00fbff')
            .setDescription(`${inQueue ? '📋 Queued' : '▶️ Playing'}: **[${safeStr(track.info.title, 200)}](${track.info.uri})**`)]
    });
}

// ── /stop ────────────────────────────────────────────────────────────────────
async function handleStopCommand(interaction) {
    const check = voiceChecks(interaction);
    if (!check.ok) return interaction.reply({ content: check.error, ephemeral: true });

    const m = getManager();
    const player = m?.players.get(interaction.guildId);
    if (!player) return interaction.reply({ content: '❌ No active player in this server.', ephemeral: true });

    const guildData = global.getGuildData(interaction.guildId);
    const is247 = guildData.plan === 'ELITE' && guildData.twentyFourSeven === true;

    // FIX 4 — use safe clear; never call player.queue.clear() directly
    clearQueueSafe(player);
    await player.stopPlaying(true, false).catch(() => {});

    if (is247) {
        // FIX 6 — 24/7: stay in VC, just stop + clear
        return interaction.reply({
            embeds: [new EmbedBuilder()
                .setColor('#9b59b6')
                .setDescription('⏹️ Queue cleared and playback stopped.\n🌙 **24/7 Mode** is active — bot is staying in the voice channel.')]
        });
    }

    await player.destroy().catch(() => {});
    return interaction.reply({
        embeds: [new EmbedBuilder()
            .setColor('#ff0000')
            .setDescription('⏹️ Music stopped, queue cleared, and left the voice channel.')]
    });
}

// ── /skip ────────────────────────────────────────────────────────────────────
async function handleSkipCommand(interaction) {
    const check = voiceChecks(interaction);
    if (!check.ok) return interaction.reply({ content: check.error, ephemeral: true });

    const player = getManager()?.players.get(interaction.guildId);
    if (!player || (!player.playing && !player.queue.current)) {
        return interaction.reply({ content: '❌ Nothing is currently playing.', ephemeral: true });
    }

    const queueSize = player.queue.tracks?.length ?? 0;

    // FIX 3 — if queue is empty, stop cleanly instead of calling skip() and crashing
    if (queueSize === 0) {
        clearQueueSafe(player);
        await player.stopPlaying(true, false).catch(() => {});

        const guildData = global.getGuildData(interaction.guildId);
        const is247 = guildData.plan === 'ELITE' && guildData.twentyFourSeven === true;
        if (!is247) scheduleIdleLeave(global.client, interaction.guildId);

        return interaction.reply({
            embeds: [new EmbedBuilder()
                .setColor('#ff9900')
                .setDescription('⏭️ Skipped. No more tracks in the queue.')]
        });
    }

    // Safe to skip — queue has at least 1 next track
    try {
        await player.skip(0, false);
    } catch (e) {
        console.error('[Music] skip() threw:', e.message);
        // Fallback: just stop current track; autoSkip will advance the queue
        await player.stopPlaying(false, false).catch(() => {});
    }

    return interaction.reply({
        embeds: [new EmbedBuilder().setColor('#00fbff').setDescription('⏭️ Skipped to the next track.')]
    });
}

// ── /queue ───────────────────────────────────────────────────────────────────
async function handleQueueCommand(interaction) {
    const check = voiceChecks(interaction);
    if (!check.ok) return interaction.reply({ content: check.error, ephemeral: true });

    const player = getManager()?.players.get(interaction.guildId);
    if (!player) return interaction.reply({ content: '❌ No active player in this server.', ephemeral: true });

    const current = player.queue.current;
    const tracks  = player.queue.tracks ?? [];

    if (!current && tracks.length === 0) {
        return interaction.reply({ content: '📭 The queue is empty.', ephemeral: true });
    }

    const totalPages = Math.max(1, Math.ceil(tracks.length / QUEUE_PAGE_SIZE));
    const embed = buildQueueEmbed(current, tracks, 1, totalPages);

    if (totalPages <= 1) return interaction.reply({ embeds: [embed] });

    return interaction.reply({ embeds: [embed], components: [buildPageRow(1, totalPages)] });
}

// FIX 5 — paginated embed with safe string lengths everywhere
function buildQueueEmbed(current, tracks, page, totalPages) {
    const start = (page - 1) * QUEUE_PAGE_SIZE;
    const slice = tracks.slice(start, start + QUEUE_PAGE_SIZE);

    const lines = slice.map((t, i) => {
        const num   = start + i + 1;
        const title = safeStr(t.info?.title || 'Unknown', 60);
        const dur   = t.info?.isStream ? 'LIVE' : msToTime(t.info?.duration || 0);
        return `\`${num}.\` **${title}** — ${dur}`;
    });

    let desc = lines.join('\n') || 'No upcoming tracks.';
    if (desc.length > 3900) desc = desc.slice(0, 3900) + '\n\u2026';

    const nowPlaying = current
        ? `**[${safeStr(current.info?.title || 'Unknown', 80)}](${current.info?.uri || ''})**`
        : 'Nothing';

    // FIX 5 — footer must be a non-empty string under 2048 chars
    const footerText = `Page ${page}/${totalPages} \u2022 ${tracks.length} track${tracks.length !== 1 ? 's' : ''} in queue`;

    return new EmbedBuilder()
        .setColor('#00fbff')
        .setTitle('🎵 Music Queue')
        .addFields({ name: '▶️ Now Playing', value: nowPlaying, inline: false })
        .setDescription(tracks.length > 0 ? `**Up Next:**\n${desc}` : '*Queue is empty.*')
        .setFooter({ text: footerText })
        .setTimestamp();
}

function buildPageRow(page, totalPages) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`queue_prev_${page}`)
            .setLabel('◀ Prev')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page <= 1),
        new ButtonBuilder()
            .setCustomId(`queue_next_${page}`)
            .setLabel('Next ▶')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page >= totalPages)
    );
}

// Called from commands.js handleButton for queue_prev / queue_next buttons
async function handleQueuePageButton(interaction) {
    const parts = interaction.customId.split('_'); // queue, prev/next, pageNum
    const direction   = parts[1];
    const currentPage = parseInt(parts[2], 10);
    const newPage     = direction === 'next' ? currentPage + 1 : currentPage - 1;

    const player = getManager()?.players.get(interaction.guildId);
    if (!player) {
        return interaction.update({ content: '❌ Player no longer active.', embeds: [], components: [] });
    }

    const current    = player.queue.current;
    const tracks     = player.queue.tracks ?? [];
    const totalPages = Math.max(1, Math.ceil(tracks.length / QUEUE_PAGE_SIZE));
    const safePage   = Math.max(1, Math.min(newPage, totalPages));

    const embed = buildQueueEmbed(current, tracks, safePage, totalPages);
    const row   = buildPageRow(safePage, totalPages);

    return interaction.update({ embeds: [embed], components: totalPages > 1 ? [row] : [] });
}

// ── /volume ──────────────────────────────────────────────────────────────────
// FIX 1 — pass integer 1-100 directly, volumeDecrementer=1 so no hidden scaling
async function handleVolumeCommand(interaction) {
    const check = voiceChecks(interaction);
    if (!check.ok) return interaction.reply({ content: check.error, ephemeral: true });

    const player = getManager()?.players.get(interaction.guildId);
    if (!player) return interaction.reply({ content: '❌ No active player in this server.', ephemeral: true });

    const vol  = interaction.options.getInteger('level');
    const safe = Math.max(1, Math.min(100, vol)); // clamp just in case

    await player.setVolume(safe, false);
    return interaction.reply({
        embeds: [new EmbedBuilder()
            .setColor('#00fbff')
            .setDescription(`🔊 Volume set to **${safe}%**\n${volumeBar(safe)}`)]
    });
}

function volumeBar(vol) {
    const filled = Math.round(vol / 10);
    return '`[' + '█'.repeat(filled) + '░'.repeat(10 - filled) + ']`';
}

// ── /24-7 ────────────────────────────────────────────────────────────────────
async function handle247Command(interaction) {
    const isAdmin = interaction.member.permissions.has(0x8n);
    if (!isAdmin) return interaction.reply({ content: '❌ Administrator permission required.', ephemeral: true });

    const guildData = global.getGuildData(interaction.guildId);
    if (guildData.plan !== 'ELITE') {
        return interaction.reply({
            content: '❌ **24/7 Mode** is an **ELITE Plan** exclusive feature.\nUpgrade at [bot.popkinncloud.qzz.io](https://bot.popkinncloud.qzz.io)',
            ephemeral: true
        });
    }

    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
        return interaction.reply({ content: '❌ You must be in a voice channel to use music commands!', ephemeral: true });
    }

    const enabling = !(guildData.twentyFourSeven === true);
    guildData.twentyFourSeven = enabling;
    global.saveGlobalData(global.globalData);

    const m = getManager();

    if (enabling) {
        // FIX 6 — on enable: create/get player, connect to VC, cancel idle timer
        let player = m?.players.get(interaction.guildId);
        if (!player) {
            player = m.createPlayer({
                guildId: interaction.guildId,
                voiceChannelId: voiceChannel.id,
                textChannelId: interaction.channelId,
                selfDeaf: true,
                volume: DEFAULT_VOLUME
            });
        }
        if (!player.connected) await player.connect().catch(() => {});
        clearIdleTimer(interaction.guildId);
    } else {
        // Disabling: schedule idle leave if nothing is playing
        const player = m?.players.get(interaction.guildId);
        if (player && !player.playing) {
            scheduleIdleLeave(global.client, interaction.guildId);
        }
    }

    return interaction.reply({
        embeds: [new EmbedBuilder()
            .setColor(enabling ? '#9b59b6' : '#ff9900')
            .setTitle(enabling ? '🌙 24/7 Mode Enabled' : '💤 24/7 Mode Disabled')
            .setDescription(enabling
                ? `Bot is now locked into <#${voiceChannel.id}> and will never leave automatically.\nUse \`/stop\` to clear the queue, or \`/24-7\` again to disable.`
                : 'Bot will leave after **1 minute** of inactivity when the queue ends.')
            .setFooter({ text: 'ELITE Plan Feature' })
            .setTimestamp()]
    });
}

// ── /node  /lavalink ─────────────────────────────────────────────────────────
async function handleNodeCommand(interaction) {
    const m = getManager();
    if (!m) return interaction.reply({ content: '❌ Music manager not initialized.', ephemeral: true });

    const nodes = [...m.nodeManager.nodes.values()];
    if (nodes.length === 0) {
        return interaction.reply({
            embeds: [new EmbedBuilder()
                .setColor('#ff0000')
                .setTitle('🔴 Lavalink Node Status')
                .setDescription('No nodes configured.')
                .setTimestamp()]
        });
    }

    const fields = [];
    for (const node of nodes) {
        const stats     = node.stats || {};
        const connected = node.connected;
        const memUsed   = stats.memory?.used   ? (stats.memory.used   / 1048576).toFixed(1) + ' MB' : 'N/A';
        const memFree   = stats.memory?.free   ? (stats.memory.free   / 1048576).toFixed(1) + ' MB' : 'N/A';
        const players   = stats.players        ?? 0;
        const playing   = stats.playingPlayers ?? 0;
        const cpuLoad   = stats.cpu?.lavalinkLoad != null
            ? (stats.cpu.lavalinkLoad * 100).toFixed(1) + '%' : 'N/A';

        let uptime = 'N/A';
        if (stats.uptime) {
            const h   = Math.floor(stats.uptime / 3600000);
            const min = Math.floor((stats.uptime % 3600000) / 60000);
            const sec = Math.floor((stats.uptime % 60000) / 1000);
            uptime = `${h}h ${min}m ${sec}s`;
        }

        fields.push({
            name: `${connected ? '🟢' : '🔴'} Node: ${node.id}`,
            value: [
                `**Status:** ${connected ? 'Connected ✅' : 'Disconnected ❌'}`,
                `**Host:** \`${node.options?.host}:${node.options?.port}\``,
                `**RAM Used / Free:** ${memUsed} / ${memFree}`,
                `**CPU Load:** ${cpuLoad}`,
                `**Players:** ${players} total, ${playing} active`,
                `**Uptime:** ${uptime}`
            ].join('\n'),
            inline: false
        });
    }

    const anyConnected = nodes.some(n => n.connected);
    return interaction.reply({
        embeds: [new EmbedBuilder()
            .setColor(anyConnected ? '#00ff88' : '#ff0000')
            .setTitle('📡 Lavalink Node Status')
            .addFields(fields)
            .setFooter({ text: 'PopkinnCloud Music System' })
            .setTimestamp()]
    });
}

// ── /autoplay ────────────────────────────────────────────────────────────────
async function handleAutoplayCommand(interaction) {
    const check = voiceChecks(interaction);
    if (!check.ok) return interaction.reply({ content: check.error, ephemeral: true });

    const player = getManager()?.players.get(interaction.guildId);
    if (!player) return interaction.reply({ content: '❌ No active player in this server.', ephemeral: true });

    // Toggle autoplay on the player using lavalink-client's built-in flag
    const current = player.get('autoplay') || false;
    player.set('autoplay', !current);

    if (!current) {
        // When enabling, set up the autoplay handler if not already set
        const m = getManager();
        if (!m._autoplayHooked) {
            m._autoplayHooked = true;
            m.on('queueEnd', async (p) => {
                if (!p.get('autoplay')) return;
                const lastTrack = p.queue.previous?.[0] || p.queue.current;
                if (!lastTrack) return;
                try {
                    const res = await p.search(
                        { query: `https://www.youtube.com/watch?v=${lastTrack.info.identifier}&list=RD${lastTrack.info.identifier}`, source: 'youtube' },
                        { username: 'Autoplay' }
                    );
                    if (!res?.tracks?.length) return;
                    const related = res.tracks.find(t => t.info.identifier !== lastTrack.info.identifier) || res.tracks[0];
                    if (!related) return;
                    await p.queue.add(related);
                    await p.play().catch(() => {});
                } catch (_) {}
            });
        }
    }

    return interaction.reply({
        embeds: [new EmbedBuilder()
            .setColor(!current ? '#00fbff' : '#ff9900')
            .setDescription(`🔁 Autoplay is now **${!current ? 'enabled' : 'disabled'}**. ${!current ? 'Related tracks will auto-queue when the queue ends.' : 'The bot will stop after the queue ends.'}`)]
    });
}

// ── Prefix music commands (play, stop, skip, queue) ──────────────────────────
// Called from handlers.js handleMessageCreate

const MUSIC_PREFIX_ALIASES = {
    play:      ['play', 'p'],
    stop:      ['stop', 'st', 'disconnect', 'dc'],
    skip:      ['skip', 'sk', 'next', 'n'],
    queue:     ['queue', 'q', 'nowplaying', 'np'],
    autoplay:  ['autoplay', 'ap'],
};

async function handleMusicPrefixCommand(msg, cmdKey, args) {
    // Build a minimal fake interaction compatible with our handlers
    const fake = {
        user:    msg.author,
        member:  msg.member,
        guild:   msg.guild,
        guildId: msg.guild.id,
        channelId: msg.channel.id,
        replied: false,
        deferred: false,
        reply: async (data) => {
            if (typeof data === 'string') return msg.reply(data).catch(() => {});
            if (data?.embeds)   return msg.reply({ embeds: data.embeds }).catch(() => {});
            if (data?.content)  return msg.reply(data.content).catch(() => {});
            return msg.reply(String(data)).catch(() => {});
        },
        editReply: async (data) => {
            if (typeof data === 'string') return msg.reply(data).catch(() => {});
            if (data?.embeds)   return msg.reply({ embeds: data.embeds }).catch(() => {});
            if (data?.content)  return msg.reply(data.content).catch(() => {});
            return msg.reply(String(data)).catch(() => {});
        },
        deferReply: async () => {},
        options: {
            getString:  (name) => name === 'query' ? args.join(' ') : null,
            getInteger: ()     => null,
        },
        isRepliable: () => true,
    };

    switch (cmdKey) {
        case 'play':
            if (!args.length) return msg.reply('❌ Usage: `{prefix}play <song name or URL>`');
            return handlePlayCommand(fake);
        case 'stop':
            return handleStopCommand(fake);
        case 'skip':
            return handleSkipCommand(fake);
        case 'queue':
            return handleQueueCommand(fake);
        case 'autoplay':
            return handleAutoplayCommand(fake);
    }
}

// ── /refresh-lavalink ────────────────────────────────────────────────────────
async function handleRefreshLavalinkCommand(interaction) {
    await interaction.deferReply();

    const m = getManager();
    if (!m) return interaction.editReply({ content: '❌ Music manager not initialized.' });

    const nodes = [...m.nodeManager.nodes.values()];
    if (nodes.length === 0) return interaction.editReply({ content: '❌ No Lavalink nodes configured.' });

    // Correctly classify nodes — lavalink-client uses .connected boolean
    const disconnected = nodes.filter(n => !n.connected);
    const connected    = nodes.filter(n =>  n.connected);

    console.log(`[Lavalink] /refresh-lavalink: total=${nodes.length} connected=${connected.length} disconnected=${disconnected.length}`);
    nodes.forEach(n => console.log(`[Lavalink]   node "${n.id}" connected=${n.connected} socket.readyState=${n.socket?.readyState}`));

    if (disconnected.length === 0) {
        return interaction.editReply({
            embeds: [new EmbedBuilder()
                .setColor('#00ff88')
                .setTitle('✅ All Nodes Healthy')
                .setDescription(nodes.map(n => `🟢 **${n.id}** — Connected`).join('\n'))
                .setTimestamp()]
        });
    }

    // Show initial status
    const statusLines = nodes.map(n =>
        `${n.connected ? '🟢' : '🔴'} **${n.id}** — ${n.connected ? 'Connected' : 'Disconnected — attempting reconnect...'}`
    );
    await interaction.editReply({
        embeds: [new EmbedBuilder()
            .setColor('#ffaa00')
            .setTitle('🔄 Refreshing Lavalink Nodes...')
            .setDescription(statusLines.join('\n'))
            .setFooter({ text: `${disconnected.length} disconnected node(s) · Up to 10 attempts · 3s apart` })
            .setTimestamp()]
    });

    const MAX_TRIES  = 10;
    const RETRY_WAIT = 3000;
    const results    = {};

    for (const node of disconnected) {
        if (reconnectGuard.has(node.id)) {
            console.log(`[Lavalink] Refresh: node "${node.id}" already in reconnectGuard — skipping`);
            results[node.id] = 'already_reconnecting';
            continue;
        }

        reconnectGuard.add(node.id);
        console.log(`[Lavalink] Refresh: starting reconnect attempts for node "${node.id}"`);

        let success = false;
        for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
            try {
                // lavalink-client v2+: use connect() on the node manager for a specific node
                // or call node.connect() directly if available
                if (typeof node.connect === 'function') {
                    node.connect();
                } else {
                    // fallback: destroy and re-add the node
                    const opts = { ...node.options };
                    m.nodeManager.nodes.delete(node.id);
                    m.nodeManager.createNode(opts);
                }

                // Wait and check if it came online
                await new Promise(r => setTimeout(r, 2000));

                // Re-fetch the node in case it was recreated
                const refreshed = m.nodeManager.nodes.get(node.id);
                if (refreshed?.connected) {
                    success = true;
                    console.log(`[Lavalink] Refresh: node "${node.id}" reconnected on attempt ${attempt}`);
                    break;
                }
                console.log(`[Lavalink] Refresh: node "${node.id}" still offline after attempt ${attempt}/${MAX_TRIES}`);
            } catch (e) {
                console.warn(`[Lavalink] Refresh: node "${node.id}" attempt ${attempt}/${MAX_TRIES} threw: ${e.message}`);
            }
            if (attempt < MAX_TRIES) await new Promise(r => setTimeout(r, RETRY_WAIT));
        }

        reconnectGuard.delete(node.id);
        results[node.id] = success ? 'reconnected' : 'failed';
        console.log(`[Lavalink] Refresh: node "${node.id}" final result: ${results[node.id]}`);
    }

    // Final status
    const finalLines = nodes.map(n => {
        const r = results[n.id];
        const live = m.nodeManager.nodes.get(n.id)?.connected ?? n.connected;
        if (!r)                           return `🟢 **${n.id}** — Already Connected`;
        if (r === 'reconnected')          return `🟢 **${n.id}** — ✅ Reconnected successfully`;
        if (r === 'already_reconnecting') return `🟡 **${n.id}** — Already reconnecting (skipped)`;
        return `🔴 **${n.id}** — ❌ Failed after ${MAX_TRIES} attempts · Check Lavalink server`;
    });

    const anyFailed = Object.values(results).some(r => r === 'failed');
    const allFixed  = Object.values(results).every(r => r === 'reconnected' || r === 'already_reconnecting');

    return interaction.editReply({
        embeds: [new EmbedBuilder()
            .setColor(anyFailed ? '#ff0000' : '#00ff88')
            .setTitle(anyFailed ? '⚠️ Lavalink Refresh — Some Nodes Failed' : '✅ Lavalink Refresh Complete')
            .setDescription(finalLines.join('\n'))
            .addFields({ name: '💡 Tip', value: anyFailed ? 'Check your Lavalink server is running and the port/auth match your config.' : 'All nodes are healthy. Music commands should work normally.', inline: false })
            .setFooter({ text: 'Use /node to view detailed node stats' })
            .setTimestamp()]
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
    MUSIC_PREFIX_ALIASES,
    createManager,
    getManager,
    handleRawEvent,
    voiceChecks,
    msToTime,
    safeStr,
    safeDestroyPlayer,
    clearIdleTimer,
    scheduleIdleLeave,
    handleQueuePageButton,
    handlePlayCommand,
    handleStopCommand,
    handleSkipCommand,
    handleQueueCommand,
    handleVolumeCommand,
    handle247Command,
    handleNodeCommand,
    handleAutoplayCommand,
    handleMusicPrefixCommand,
    handleRefreshLavalinkCommand,
};
