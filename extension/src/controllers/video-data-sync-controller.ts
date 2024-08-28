import {
    ActiveProfileMessage,
    ConfirmedVideoDataSubtitleTrack,
    OpenAsbplayerSettingsMessage,
    SerializedSubtitleFile,
    SettingsUpdatedMessage,
    VideoData,
    VideoDataSubtitleTrack,
    VideoDataUiBridgeConfirmMessage,
    VideoDataUiBridgeOpenFileMessage,
    VideoDataUiModel,
    VideoDataUiOpenReason,
    VideoToExtensionCommand,
    VideoDataSearchMessage,
    UpdateEpisodeMessage,
} from '@project/common';
import { AsbplayerSettings, SettingsProvider } from '@project/common/settings';
import { base64ToBlob, bufferToBase64 } from '@project/common/base64';
import Binding from '../services/binding';
import { currentPageDelegate } from '../services/pages';
import { Parser as m3U8Parser } from 'm3u8-parser';
import UiFrame from '../services/ui-frame';
import { fetchLocalization } from '../services/localization-fetcher';
import i18n from 'i18next';
import { fetchAnilistInfo } from '../services/anilist';
import { fetchSubtitles } from '../services/subtitle';

async function html(lang: string) {
    return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="utf-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1" />
                <title>asbplayer - Video Data Sync</title>
                <style>
                    @import url(${chrome.runtime.getURL('./assets/fonts.css')});
                </style>
            </head>
            <body>
                <div id="root" style="width:100%;height:100vh;"></div>
                <script type="application/json" id="loc">${JSON.stringify(await fetchLocalization(lang))}</script>
                <script type="module" src="${chrome.runtime.getURL('./video-data-sync-ui.js')}"></script>
            </body>
            </html>`;
}

interface ShowOptions {
    reason: VideoDataUiOpenReason;
    fromAsbplayerId?: string;
}

const fetchDataForLanguageOnDemand = (language: string): Promise<VideoData> => {
    return new Promise((resolve, reject) => {
        const listener = (event: Event) => {
            const data = (event as CustomEvent).detail as VideoData;
            resolve(data);
            document.removeEventListener('asbplayer-synced-language-data', listener, false);
        };
        document.addEventListener('asbplayer-synced-language-data', listener, false);
        document.dispatchEvent(new CustomEvent('asbplayer-get-synced-language-data', { detail: language }));
    });
};

export default class VideoDataSyncController {
    private readonly _context: Binding;
    private readonly _domain: string;
    private readonly _frame: UiFrame;
    private readonly _settings: SettingsProvider;

    private _autoSync?: boolean;
    private _lastLanguagesSynced: { [key: string]: string[] };
    private _emptySubtitle: VideoDataSubtitleTrack;
    private _syncedData?: VideoData;
    private _wasPaused?: boolean;
    private _fullscreenElement?: Element;
    private _activeElement?: Element;
    private _autoSyncAttempted: boolean = false;
    private _dataReceivedListener?: (event: Event) => void;
    private _episode: number | '' = '';
    private _isAnimeSite: boolean = false;

    constructor(context: Binding, settings: SettingsProvider) {
        this._context = context;
        this._settings = settings;
        this._autoSync = false;
        this._lastLanguagesSynced = {};
        this._emptySubtitle = {
            id: '-',
            language: '-',
            url: '-',
            label: i18n.t('extension.videoDataSync.emptySubtitleTrack'),
            extension: 'srt',
        };
        this._domain = new URL(window.location.href).host;
        this._frame = new UiFrame(html);
        this._isAnimeSite = false;
        this.checkIfAnimeSite();
    }

    private get lastLanguagesSynced(): string[] {
        return this._lastLanguagesSynced[this._domain] ?? [];
    }

    private set lastLanguagesSynced(value: string[]) {
        this._lastLanguagesSynced[this._domain] = value;
    }

    unbind() {
        if (this._dataReceivedListener) {
            document.removeEventListener('asbplayer-synced-data', this._dataReceivedListener, false);
        }

        this._dataReceivedListener = undefined;
        this._syncedData = undefined;
    }

    updateSettings({ streamingAutoSync, streamingLastLanguagesSynced }: AsbplayerSettings) {
        this._autoSync = streamingAutoSync;
        this._lastLanguagesSynced = streamingLastLanguagesSynced;

        if (this._frame.clientIfLoaded !== undefined) {
            this._context.settings.getSingle('themeType').then((themeType) => {
                const profilesPromise = this._context.settings.profiles();
                const activeProfilePromise = this._context.settings.activeProfile();
                Promise.all([profilesPromise, activeProfilePromise]).then(([profiles, activeProfile]) => {
                    this._frame.clientIfLoaded?.updateState({
                        settings: {
                            themeType,
                            profiles,
                            activeProfile: activeProfile?.name,
                        },
                    });
                });
            });
        }
    }

    requestSubtitles() {
        if (!this._context.hasPageScript || !currentPageDelegate()?.isVideoPage()) {
            return;
        }

        this._syncedData = undefined;
        this._autoSyncAttempted = false;

        if (!this._dataReceivedListener) {
            this._dataReceivedListener = (event: Event) => {
                const data = (event as CustomEvent).detail as VideoData;
                this._setSyncedData(data);
            };
            document.addEventListener('asbplayer-synced-data', this._dataReceivedListener, false);
        }

        document.dispatchEvent(new CustomEvent('asbplayer-get-synced-data'));
    }

    async show({ reason, fromAsbplayerId }: ShowOptions) {
        const client = await this._client();
        const additionalFields: Partial<VideoDataUiModel> = {
            open: true,
            openReason: reason,
        };

        if (fromAsbplayerId !== undefined) {
            additionalFields.openedFromAsbplayerId = fromAsbplayerId;
        }

        const model = await this._buildModel(additionalFields);
        this._prepareShow();
        client.updateState(model);
    }

    private async _buildModel(additionalFields: Partial<VideoDataUiModel>) {
        const subtitleTrackChoices = this._syncedData?.subtitles ?? [];
        const subs = this._matchLastSyncedWithAvailableTracks();
        const autoSelectedTracks: VideoDataSubtitleTrack[] = subs.autoSelectedTracks;
        const autoSelectedTrackIds = autoSelectedTracks.map((subtitle) => subtitle.id || '-');
        const defaultCheckboxState: boolean = subs.completeMatch;
        const themeType = await this._context.settings.getSingle('themeType');
        const profilesPromise = this._context.settings.profiles();
        const activeProfilePromise = this._context.settings.activeProfile();
        const { title, episode } = await this.getAnimeTitleAndEpisode();

        return this._syncedData
            ? {
                  isLoading: this._syncedData.subtitles === undefined,
                  suggestedName: title ? title : this._syncedData.basename,
                  selectedSubtitle: autoSelectedTrackIds,
                  subtitles: subtitleTrackChoices,
                  error: this._syncedData.error,
                  defaultCheckboxState: defaultCheckboxState,
                  openedFromAsbplayerId: '',
                  settings: {
                      themeType,
                      profiles: await profilesPromise,
                      activeProfile: (await activeProfilePromise)?.name,
                  },
                  //  todo: put these in one state object
                  episode: episode ? episode : this._episode,
                  isAnimeSite: this._isAnimeSite,
                  ...additionalFields,
              }
            : {
                  isLoading: this._context.hasPageScript,
                  suggestedName: title ? title : document.title,
                  selectedSubtitle: autoSelectedTrackIds,
                  error: '',
                  showSubSelect: true,
                  subtitles: subtitleTrackChoices,
                  defaultCheckboxState: defaultCheckboxState,
                  openedFromAsbplayerId: '',
                  settings: {
                      themeType,
                      profiles: await profilesPromise,
                      activeProfile: (await activeProfilePromise)?.name,
                  },
                  episode: this._episode,
                  isAnimeSite: this._isAnimeSite,
                  ...additionalFields,
              };
    }

    private _matchLastSyncedWithAvailableTracks() {
        const subtitleTrackChoices = this._syncedData?.subtitles ?? [];
        let tracks = {
            autoSelectedTracks: [this._emptySubtitle, this._emptySubtitle, this._emptySubtitle],
            completeMatch: false,
        };

        const emptyChoice = this.lastLanguagesSynced.some((lang) => lang !== '-') === undefined;

        if (!subtitleTrackChoices.length && emptyChoice) {
            tracks.completeMatch = true;
        } else {
            let matches: number = 0;
            for (let i = 0; i < this.lastLanguagesSynced.length; i++) {
                const language = this.lastLanguagesSynced[i];
                for (let j = 0; j < subtitleTrackChoices.length; j++) {
                    if (language === '-') {
                        matches++;
                        break;
                    } else if (language === subtitleTrackChoices[j].language) {
                        tracks.autoSelectedTracks[i] = subtitleTrackChoices[j];
                        matches++;
                        break;
                    }
                }
            }
            if (matches === this.lastLanguagesSynced.length) {
                tracks.completeMatch = true;
            }
        }

        return tracks;
    }

    private _defaultVideoName(basename: string | undefined, subtitleTrack: VideoDataSubtitleTrack) {
        if (subtitleTrack.url === '-') {
            return basename ?? '';
        }

        if (basename) {
            return `${basename} - ${subtitleTrack.label}`;
        }

        return subtitleTrack.label;
    }

    private async _setSyncedData(data: VideoData) {
        this._syncedData = data;

        if (this._syncedData?.subtitles !== undefined && this._canAutoSync()) {
            if (!this._autoSyncAttempted) {
                this._autoSyncAttempted = true;
                const subs = this._matchLastSyncedWithAvailableTracks();

                if (subs.completeMatch) {
                    const autoSelectedTracks: VideoDataSubtitleTrack[] = subs.autoSelectedTracks;
                    await this._syncData(autoSelectedTracks);

                    if (!this._frame.hidden) {
                        this._hideAndResume();
                    }
                } else {
                    await this.show({ reason: VideoDataUiOpenReason.failedToAutoLoadPreferredTrack });
                }
            }
        } else if (this._frame.clientIfLoaded !== undefined) {
            this._frame.clientIfLoaded.updateState(await this._buildModel({}));
        }
    }

    private _canAutoSync(): boolean {
        const page = currentPageDelegate();

        if (page === undefined) {
            return this._autoSync ?? false;
        }

        return this._autoSync === true && page.canAutoSync(this._context.video);
    }

    private async _client() {
        this._frame.language = await this._settings.getSingle('language');
        const isNewClient = await this._frame.bind();
        const client = await this._frame.client();

        if (isNewClient) {
            client.onMessage(async (message) => {
                if ('openSettings' === message.command) {
                    const openSettingsCommand: VideoToExtensionCommand<OpenAsbplayerSettingsMessage> = {
                        sender: 'asbplayer-video',
                        message: {
                            command: 'open-asbplayer-settings',
                        },
                        src: this._context.video.src,
                    };
                    chrome.runtime.sendMessage(openSettingsCommand);
                    return;
                }

                if ('activeProfile' === message.command) {
                    const activeProfileMessage = message as ActiveProfileMessage;
                    await this._context.settings.setActiveProfile(activeProfileMessage.profile);
                    const settingsUpdatedCommand: VideoToExtensionCommand<SettingsUpdatedMessage> = {
                        sender: 'asbplayer-video',
                        message: {
                            command: 'settings-updated',
                        },
                        src: this._context.video.src,
                    };
                    chrome.runtime.sendMessage(settingsUpdatedCommand);
                    return;
                }

                let dataWasSynced = true;

                if ('confirm' === message.command) {
                    const confirmMessage = message as VideoDataUiBridgeConfirmMessage;

                    if (confirmMessage.shouldRememberTrackChoices) {
                        this.lastLanguagesSynced = confirmMessage.data
                            .map((track) => track.language)
                            .filter((language) => language !== undefined) as string[];
                        await this._context.settings
                            .set({ streamingLastLanguagesSynced: this._lastLanguagesSynced })
                            .catch(() => {});
                    }

                    const data = confirmMessage.data as ConfirmedVideoDataSubtitleTrack[];

                    dataWasSynced = await this._syncDataArray(data, confirmMessage.syncWithAsbplayerId);
                } else if ('openFile' === message.command) {
                    const openFileMessage = message as VideoDataUiBridgeOpenFileMessage;
                    const subtitles = openFileMessage.subtitles as SerializedSubtitleFile[];

                    try {
                        await this._syncSubtitles(subtitles, false);
                        dataWasSynced = true;
                    } catch (e) {
                        if (e instanceof Error) {
                            await this._reportError(e.message);
                        }
                    }
                } else if ('updateEpisode' === message.command) {
                    const updateEpisodeMessage = message as UpdateEpisodeMessage;
                    this._episode = updateEpisodeMessage.episode;
                    client.updateState({ episode: this._episode, open: true });
                    dataWasSynced = false;
                } else if ('search' === message.command) {
                    const searchSubtitlesMessage = message as VideoDataSearchMessage;
                    await this._handleSearch(searchSubtitlesMessage);
                    dataWasSynced = false;
                }

                if (dataWasSynced) {
                    this._hideAndResume();
                }
            });
        }

        this._frame.show();
        return client;
    }

    private async _prepareShow() {
        const client = await this._client();
        await this.checkIfAnimeSite();
        const { title, episode } = await this.getAnimeTitleAndEpisode();

        client.updateState({
            isAnimeSite: this._isAnimeSite,
            suggestedName: title || this._syncedData?.basename || document.title,
            episode: episode ? parseInt(episode) : '',
            open: true,
        });

        this._wasPaused = this._wasPaused ?? this._context.video.paused;
        this._context.pause();

        if (document.fullscreenElement) {
            this._fullscreenElement = document.fullscreenElement;
            document.exitFullscreen();
        }

        if (document.activeElement) {
            this._activeElement = document.activeElement;
        }

        this._context.keyBindings.unbind();
        this._context.subtitleController.forceHideSubtitles = true;
        this._context.mobileVideoOverlayController.forceHide = true;
    }

    private _hideAndResume() {
        this._context.keyBindings.bind(this._context);
        this._context.subtitleController.forceHideSubtitles = false;
        this._context.mobileVideoOverlayController.forceHide = false;
        this._frame?.hide();

        if (this._fullscreenElement) {
            this._fullscreenElement.requestFullscreen();
            this._fullscreenElement = undefined;
        }

        if (this._activeElement) {
            if (typeof (this._activeElement as HTMLElement).focus === 'function') {
                (this._activeElement as HTMLElement).focus();
            }

            this._activeElement = undefined;
        } else {
            window.focus();
        }

        if (!this._wasPaused) {
            this._context.play();
        }

        this._wasPaused = undefined;
    }

    private async _syncData(data: VideoDataSubtitleTrack[]) {
        try {
            let subtitles: SerializedSubtitleFile[] = [];

            for (let i = 0; i < data.length; i++) {
                const { extension, url, language, localFile } = data[i];
                const subtitleFiles = await this._subtitlesForUrl(
                    this._defaultVideoName(this._syncedData?.basename, data[i]),
                    language,
                    extension,
                    url,
                    localFile
                );
                if (subtitleFiles !== undefined) {
                    subtitles.push(...subtitleFiles);
                }
            }

            await this._syncSubtitles(
                subtitles,
                data.some((track) => track.extension === 'm3u8')
            );
            return true;
        } catch (error) {
            if (typeof (error as Error).message !== 'undefined') {
                await this._reportError(`Data Sync failed: ${(error as Error).message}`);
            }

            return false;
        }
    }

    private async _syncDataArray(data: ConfirmedVideoDataSubtitleTrack[], syncWithAsbplayerId?: string) {
        try {
            let subtitles: SerializedSubtitleFile[] = [];

            for (let i = 0; i < data.length; i++) {
                const { name, language, extension, url, localFile } = data[i];
                const subtitleFiles = await this._subtitlesForUrl(name, language, extension, url, localFile);
                if (subtitleFiles !== undefined) {
                    subtitles.push(...subtitleFiles);
                }
            }

            await this._syncSubtitles(
                subtitles,
                data.some((track) => track.extension === 'm3u8'),
                syncWithAsbplayerId
            );
            return true;
        } catch (error) {
            if (typeof (error as Error).message !== 'undefined') {
                await this._reportError(`Data Sync failed: ${(error as Error).message}`);
            }

            return false;
        }
    }

    private async _syncSubtitles(
        serializedFiles: SerializedSubtitleFile[],
        flatten: boolean,
        syncWithAsbplayerId?: string
    ) {
        const files: File[] = await Promise.all(
            serializedFiles.map(async (f) => new File([base64ToBlob(f.base64, 'text/plain')], f.name))
        );
        this._context.loadSubtitles(files, flatten, syncWithAsbplayerId);
    }

    private async _subtitlesForUrl(
        name: string,
        language: string | undefined,
        extension: string,
        url: string,
        localFile: boolean | undefined
    ): Promise<SerializedSubtitleFile[] | undefined> {
        if (url === '-') {
            return [
                {
                    name: `${name}.${extension}`,
                    base64: '',
                },
            ];
        }

        if (url === 'lazy') {
            if (language === undefined) {
                await this._reportError('Unable to determine language');
                return undefined;
            }

            const data = await fetchDataForLanguageOnDemand(language);

            if (data.error) {
                await this._reportError(data.error);
                return undefined;
            }

            const lazilyFetchedUrl = data.subtitles?.find((t) => t.language === language)?.url;

            if (lazilyFetchedUrl === undefined) {
                await this._reportError('Failed to fetch subtitles for specified language');
                return undefined;
            }

            url = lazilyFetchedUrl;
        }

        const response = await fetch(url)
            .catch((error) => this._reportError(error.message))
            .finally(() => {
                if (localFile) {
                    URL.revokeObjectURL(url);
                }
            });

        if (!response) {
            return undefined;
        }

        if (extension === 'm3u8') {
            const m3U8Response = await fetch(url);
            const parser = new m3U8Parser();
            parser.push(await m3U8Response.text());
            parser.end();

            if (!parser.manifest.segments || parser.manifest.segments.length === 0) {
                return undefined;
            }

            const firstUri = parser.manifest.segments[0].uri;
            const partExtension = firstUri.substring(firstUri.lastIndexOf('.') + 1);
            const m3U8BaseUrl = url.substring(0, url.lastIndexOf('/'));
            const fileName = `${name}.${partExtension}`;
            const promises = parser.manifest.segments
                .filter((s: any) => !s.discontinuity && s.uri)
                .map((s: any) => fetch(`${m3U8BaseUrl}/${s.uri}`));
            const tracks = [];
            let totalPromises = promises.length;
            let finishedPromises = 0;

            for (const p of promises) {
                const response = await p;

                if (!response.ok) {
                    throw new Error(
                        `Subtitle Retrieval failed with Status ${response.status}/${response.statusText}...`
                    );
                }

                ++finishedPromises;
                this._context.subtitleController.notification(
                    `${fileName} (${Math.floor((finishedPromises / totalPromises) * 100)}%)`
                );

                tracks.push({
                    name: fileName,
                    base64: bufferToBase64(await response.arrayBuffer()),
                });
            }

            return tracks;
        }

        if (!response.ok) {
            throw new Error(`Subtitle Retrieval failed with Status ${response.status}/${response.statusText}...`);
        }

        return [
            {
                name: `${name}.${extension}`,
                base64: response ? bufferToBase64(await response.arrayBuffer()) : '',
            },
        ];
    }

    private async _reportError(error: string) {
        const client = await this._client();
        const themeType = await this._context.settings.getSingle('themeType');

        this._prepareShow();

        return client.updateState({
            open: true,
            isLoading: false,
            showSubSelect: true,
            error,
            themeType: themeType,
        });
    }

    private async _handleSearch(message: VideoDataSearchMessage) {
        const client = await this._client();
        client.updateState({ isLoading: true, error: null, open: true });

        const apiKey = await this._context.settings.getSingle('apiKey');

        try {
            const { anilistId } = await fetchAnilistInfo(message.title);
            if (!anilistId) {
                throw new Error('Unable to find Anilist ID for the given title');
            }

            const subtitles = await fetchSubtitles(anilistId, message.episode || 0, apiKey || '');
            if (typeof subtitles === 'string') {
                throw new Error(subtitles);
            }

            const fetchedSubtitles = subtitles
                .map((sub, index) => ({
                    id: `fetched-${index}`,
                    language: 'ja',
                    url: sub.url,
                    label: sub.name,
                    extension: 'srt',
                }))
                .filter((sub) => sub.url && sub.label);

            const { title } = await this.getAnimeTitleAndEpisode();

            // Update the subtitles state with the fetched subtitles
            this._syncedData = {
                ...this._syncedData,
                subtitles: [
                    { id: '-', language: '-', url: '-', label: 'No subtitle', extension: 'srt' },
                    ...fetchedSubtitles,
                ],
            } as VideoData;

            // Make sure to keep the dialog open after updating state
            client.updateState({
                subtitles: this._syncedData.subtitles,
                isLoading: false,
                episode: message.episode,
                open: true,
                suggestedName: title,
            });
        } catch (error) {
            // Keep dialog open when showing error
            client.updateState({
                error: error instanceof Error ? error.message : 'An error occurred while fetching subtitles',
                isLoading: false,
                open: true,
            });
        }
    }

    private async checkIfAnimeSite(): Promise<void> {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage({ command: 'CHECK_IF_ANIME_SITE' }, (response) => {
                this._isAnimeSite = response.isAnimeSite;
                resolve();
            });
        });
    }
    private async getAnimeTitleAndEpisode(): Promise<{ title: string; episode: string }> {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage({ command: 'GET_ANIME_TITLE_AND_EPISODE' }, (response) => {
                if (response.error) {
                    resolve({ title: '', episode: '' });
                } else {
                    resolve({ title: response.title, episode: response.episode.toString() });
                }
            });
        });
    }
}
