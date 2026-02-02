/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { ApplicationCommandInputType, ApplicationCommandOptionType, sendBotMessage } from "@api/Commands";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { findStoreLazy } from "@webpack";
import { FluxDispatcher, RestAPI } from "@webpack/common";

interface Quest {
    id: string;
    config: {
        expiresAt: string;
        messages: {
            questName: string;
        };
        application: {
            id: string;
            name: string;
        };
        taskConfig?: any;
        taskConfigV2?: any;
        configVersion?: number;
    };
    userStatus?: {
        enrolledAt: string;
        completedAt?: string;
        progress?: Record<string, { value: number }>;
        streamProgressSeconds?: number;
    };
}

const QuestsStore = findStoreLazy("QuestsStore") as { quests: Map<string, Quest> };
const RunningGameStore = findStoreLazy("RunningGameStore") as any;

let isRunning = false;
let totalQuests = 0;
let completedQuests = 0;
let activeQuestHandlers: Map<string, () => void> = new Map();

const settings = {
    excludedQuestId: "1412491570820812933",
    playSpeed: 7
};

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function getIncompleteQuests(): Quest[] {
    return [...QuestsStore.quests.values()].filter(
        x => x.id !== settings.excludedQuestId &&
            x.userStatus?.enrolledAt &&
            !x.userStatus?.completedAt &&
            new Date(x.config.expiresAt).getTime() > Date.now()
    );
}

async function handleVideoQuest(quest: Quest, taskName: string): Promise<void> {
    const questName = quest.config.messages.questName;
    const taskConfig = quest.config.taskConfig ?? quest.config.taskConfigV2;
    const secondsNeeded = taskConfig.tasks[taskName].target;
    let secondsDone = quest.userStatus?.progress?.[taskName]?.value ?? 0;

    const maxFuture = 10;
    const speed = settings.playSpeed;
    const interval = 1;
    const enrolledAt = new Date(quest.userStatus!.enrolledAt).getTime();
    let completed = false;

    while (isRunning && activeQuestHandlers.has(quest.id)) {
        const maxAllowed = Math.floor((Date.now() - enrolledAt) / 1000) + maxFuture;
        const diff = maxAllowed - secondsDone;
        const timestamp = secondsDone + speed;

        if (diff >= speed) {
            try {
                const res = await RestAPI.post({
                    url: `/quests/${quest.id}/video-progress`,
                    body: { timestamp: Math.min(secondsNeeded, timestamp + Math.random()) }
                });
                completed = res.body.completed_at != null;
                secondsDone = Math.min(secondsNeeded, timestamp);
            } catch (error) {
                console.error(`❌ [${questName}] Error updating progress:`, error);
                break;
            }
        }

        if (timestamp >= secondsNeeded) break;
        await wait(interval * 1000);
    }

    if (!completed && isRunning && activeQuestHandlers.has(quest.id)) {
        try {
            await RestAPI.post({
                url: `/quests/${quest.id}/video-progress`,
                body: { timestamp: secondsNeeded }
            });
        } catch (error) {
            console.error(`❌ [${questName}] Error completing quest:`, error);
        }
    }

    if (activeQuestHandlers.has(quest.id)) {
        activeQuestHandlers.delete(quest.id);
        completedQuests++;

        if (completedQuests >= totalQuests) 
            isRunning = false;
    }
}

async function handleGameQuest(quest: Quest, taskName: string): Promise<void> {
    if (typeof DiscordNative === "undefined") {
        activeQuestHandlers.delete(quest.id);
        return;
    }

    const questName = quest.config.messages.questName;
    const applicationId = quest.config.application.id;
    const applicationName = quest.config.application.name;
    const taskConfig = quest.config.taskConfig ?? quest.config.taskConfigV2;
    const secondsNeeded = taskConfig.tasks[taskName].target;
    const pid = Math.floor(Math.random() * 30000) + 1000;

    try {
        const res = await RestAPI.get({
            url: `/applications/public?application_ids=${applicationId}`
        });
        const appData = res.body[0];
        const exeName = appData.executables.find((x: any) => x.os === "win32")?.name.replace(">", "") || "game.exe";

        const fakeGame = {
            cmdLine: `C:\\Program Files\\${appData.name}\\${exeName}`,
            exeName,
            exePath: `c:/program files/${appData.name.toLowerCase()}/${exeName}`,
            hidden: false,
            isLauncher: false,
            id: applicationId,
            name: appData.name,
            pid: pid,
            pidPath: [pid],
            processName: appData.name,
            start: Date.now(),
        };

        const realGames = RunningGameStore.getRunningGames();
        const currentFakeGames = realGames.filter((g: any) => g.pid >= 1000 && g.pid < 60000);
        const fakeGames = [...currentFakeGames, fakeGame];

        const realGetRunningGames = RunningGameStore.getRunningGames;
        const realGetGameForPID = RunningGameStore.getGameForPID;

        RunningGameStore.getRunningGames = () => fakeGames;
        RunningGameStore.getGameForPID = (p: number) => fakeGames.find(x => x.pid === p);
        FluxDispatcher.dispatch({
            type: "RUNNING_GAMES_CHANGE",
            removed: [],
            added: [fakeGame],
            games: fakeGames
        });

        return new Promise<void>(resolve => {
            const fn = (data: any) => {
                if (!isRunning || !activeQuestHandlers.has(quest.id)) {
                    const currentGames = RunningGameStore.getRunningGames();
                    const updatedGames = currentGames.filter((g: any) => g.pid !== pid);

                    if (updatedGames.length === 0) {
                        RunningGameStore.getRunningGames = realGetRunningGames;
                        RunningGameStore.getGameForPID = realGetGameForPID;
                    } else {
                        RunningGameStore.getRunningGames = () => updatedGames;
                    }

                    FluxDispatcher.dispatch({
                        type: "RUNNING_GAMES_CHANGE",
                        removed: [fakeGame],
                        added: [],
                        games: updatedGames.length === 0 ? [] : updatedGames
                    });
                    FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", fn);
                    resolve();
                    return;
                }

                const progress = quest.config.configVersion === 1
                    ? data.userStatus.streamProgressSeconds
                    : Math.floor(data.userStatus.progress.PLAY_ON_DESKTOP.value);

                if (progress >= secondsNeeded) {

                    const currentGames = RunningGameStore.getRunningGames();
                    const updatedGames = currentGames.filter((g: any) => g.pid !== pid);

                    if (updatedGames.length === 0) {
                        RunningGameStore.getRunningGames = realGetRunningGames;
                        RunningGameStore.getGameForPID = realGetGameForPID;
                    } else {
                        RunningGameStore.getRunningGames = () => updatedGames;
                    }

                    FluxDispatcher.dispatch({
                        type: "RUNNING_GAMES_CHANGE",
                        removed: [fakeGame],
                        added: [],
                        games: updatedGames.length === 0 ? [] : updatedGames
                    });
                    FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", fn);

                    activeQuestHandlers.delete(quest.id);
                    completedQuests++;

                    if (completedQuests >= totalQuests) 
                        isRunning = false;

                    resolve();
                }
            };
            FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", fn);
        });
    } catch (error) {
        console.error(`❌ [${questName}] Error:`, error);
        activeQuestHandlers.delete(quest.id);
    }
}

async function handleQuest(quest: Quest): Promise<void> {
    const questName = quest.config.messages.questName;
    const taskConfig = quest.config.taskConfig ?? quest.config.taskConfigV2;
    const taskName = ["WATCH_VIDEO", "PLAY_ON_DESKTOP", "STREAM_ON_DESKTOP", "PLAY_ACTIVITY", "WATCH_VIDEO_ON_MOBILE"]
        .find(x => taskConfig.tasks[x] != null);

    if (!taskName) {
        activeQuestHandlers.delete(quest.id);
        return;
    }

    if (taskName === "WATCH_VIDEO" || taskName === "WATCH_VIDEO_ON_MOBILE")
        await handleVideoQuest(quest, taskName);
    else if (taskName === "PLAY_ON_DESKTOP")
        await handleGameQuest(quest, taskName);
    else 
        activeQuestHandlers.delete(quest.id);
}

function startQuestCompletion() {
    if (isRunning) 
        return { alreadyRunning: true };

    const incompleteQuests = getIncompleteQuests();
    totalQuests = incompleteQuests.length;
    completedQuests = 0;
    activeQuestHandlers.clear();

    if (totalQuests === 0) {
        return {
            success: false,
            message: "`❌`・***No quests found***",
            totalQuests: 0,
            questsList: []
        };
    }

    isRunning = true;
    const questsList = incompleteQuests.map((q, i) => `${i + 1}. ${q.config.messages.questName}`);

    incompleteQuests.forEach(quest => {
        activeQuestHandlers.set(quest.id, () => { });
        handleQuest(quest);
    });

    return {
        success: true,
        totalQuests,
        questsList
    };
}

function stopQuestCompletion() {
    if (!isRunning) 
        return { notRunning: true };

    isRunning = false;
    activeQuestHandlers.clear();
    return {
        stopped: true,
        completed: completedQuests,
        total: totalQuests
    };
}

export default definePlugin({
    name: "AutoQuest",
    authors: [{ name: "Sami", id: 1403404140461297816n }],
    description: "Adds slash commands to complete your quests.",

    commands: [
        {
            name: "queststart",
            description: "Start all quests",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: (_, ctx) => {
                const result = startQuestCompletion();

                if (result.alreadyRunning) {
                    sendBotMessage(ctx.channel.id, {
                        content: "`✅`・***Quests are already running***"
                    });
                    return;
                }

                if (!result.success) {
                    sendBotMessage(ctx.channel.id, {
                        content: result.message
                    });
                    return;
                }

                const incompleteQuests = getIncompleteQuests();
                const questNames = incompleteQuests.map(q => `\`${q.config.messages.questName}\``).join(', ');
                sendBotMessage(ctx.channel.id, {
                    content: `\`✅\`・***Quests ${questNames} are running***`
                });
            }
        },
        {
            name: "queststop",
            description: "Stop automatic quest completion",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [],
            execute: (_, ctx) => {
                const result = stopQuestCompletion();

                if (result.notRunning) {
                    sendBotMessage(ctx.channel.id, {
                        content: "\`⚠️\`・***Quests are not running***"
                    });
                    return;
                }

                sendBotMessage(ctx.channel.id, {
                    content: `\`⚠️\`・***Quests stopped!***\n\n\`📊\`***・Progress: \`${result.completed}/${result.total}\` quests completed***`
                });
            }
        },
        {
            name: "queststatus",
            description: "Show quest status",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [],
            execute: (_, ctx) => {
                if (!isRunning) {
                    const incompleteQuests = getIncompleteQuests();
                    const questsList = incompleteQuests.length > 0
                        ? `\n\`📋\`・***Available quests***\n${incompleteQuests.map((q, i) => `\`${i + 1}\` - ***${q.config.messages.questName}***`).join('\n')}`
                        : "\n`✅`・***No quests available***";

                    sendBotMessage(ctx.channel.id, {
                        content: `# ***Quest Completer***\n\n\`⚠️\`・***Not running***${questsList}`
                    });
                    return;
                }

                const activeCount = activeQuestHandlers.size;
                sendBotMessage(ctx.channel.id, {
                    content: `***Quest Completer***\n\`✅\`・***Running***\n\`📊\`・***Progress: \`${completedQuests}/${totalQuests}\` completed***\n\`⚡\`・***Active: \`${activeCount}\` quest(s) in progress***`
                });
            }
        }
    ],

    stop() {
        stopQuestCompletion();
    }
});
