// ==UserScript==
// @name         Knigavuhe Enhanced
// @namespace    https://github.com/enterbrain42/knigavuhe_enchanced
// @version      0.1.0
// @description  Small quality-of-life improvements for knigavuhe.org.
// @author       enterbrain42
// @license      MIT
// @match        https://knigavuhe.org/*
// @match        https://*.knigavuhe.org/*
// @icon         https://knigavuhe.org/favicon.ico
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const SCRIPT_NAME = 'Knigavuhe Enhanced';
  const DEBUG = false;
  const PLAYER_HEAD_SELECTOR = '#book_player_head';
  const PLAYER_SELECTOR = '#book_player';
  const PLAYLIST_SELECTOR = '#player_playlist';
  const PLAYLIST_ITEM_SELECTOR = '.book_playlist_item';
  const BOOK_INFO_LABEL_SELECTOR = '.book_info_label';
  const PLAYER_INFO_BLOCK_ID = 'knigavuhe_enhanced_player_info';
  const state = {
    bookDurationSeconds: null,
    chapterDurationsByKey: new Map(),
    chapterProgressByKey: new Map(),
    activeChapterKey: null,
    playlist: null,
    playlistObserver: null,
    playlistUpdateScheduled: false,
  };

  const log = (...args) => {
    if (DEBUG) {
      console.log(`[${SCRIPT_NAME}]`, ...args);
    }
  };

  const ready = (callback) => {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', callback, { once: true });
      return;
    }

    callback();
  };

  const injectStyles = () => {
    if (document.querySelector('style[data-knigavuhe-enhanced="true"]')) {
      return;
    }

    const style = document.createElement('style');
    style.dataset.knigavuheEnhanced = 'true';
    style.textContent = `
      #${PLAYER_INFO_BLOCK_ID} {
        box-sizing: border-box;
        display: block;
        margin: 0 15px;
        padding: 6px 9px;
        border-bottom: 1px solid rgba(0, 0, 0, 0.18);
        background: rgba(255, 255, 255, 0.06);
        color: inherit;
        font-size: 13px;
        line-height: 1.3;
      }

      #${PLAYER_INFO_BLOCK_ID} .ke-player-info-row {
        display: flex;
        align-items: baseline;
        min-width: 0;
        gap: 6px;
      }

      #${PLAYER_INFO_BLOCK_ID} .ke-player-info-row + .ke-player-info-row {
        margin-top: 2px;
      }

      #${PLAYER_INFO_BLOCK_ID} .ke-player-info-label {
        flex: 0 0 auto;
        color: #777;
      }

      #${PLAYER_INFO_BLOCK_ID} .ke-player-info-value {
        min-width: 0;
        color: #111;
        font-weight: 600;
      }

      #${PLAYER_INFO_BLOCK_ID} .ke-player-info-title {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      #${PLAYER_INFO_BLOCK_ID} .ke-player-info-time {
        font-variant-numeric: tabular-nums;
      }

      #book_player_head {
        border-bottom: 1px solid rgba(0, 0, 0, 0.18);
        padding-bottom: 8px;
      }

      #book_player_head_wrap {
        border-bottom: 1px solid rgba(0, 0, 0, 0.18);
        padding-bottom: 8px;
      }

      .book_player_head_progress {
        margin-top: 8px;
      }
    `;
    document.head.append(style);
  };

  const createPlayerInfoBlock = () => {
    const block = document.createElement('div');
    block.id = PLAYER_INFO_BLOCK_ID;
    block.dataset.knigavuheEnhanced = 'player-info';
    block.setAttribute('aria-live', 'polite');
    return block;
  };

  const addPlayerInfoBlock = (playerHead) => {
    if (!playerHead || document.getElementById(PLAYER_INFO_BLOCK_ID)) {
      return true;
    }

    playerHead.insertAdjacentElement('afterend', createPlayerInfoBlock());
    log('player info block added');
    return true;
  };

  const getChapterKey = (item, index) => item.id || `chapter-${index}`;

  const parseTimeToSeconds = (time) => {
    const parts = time
      .trim()
      .split(':')
      .map((part) => Number.parseInt(part, 10));

    if (parts.length < 2 || parts.length > 3 || parts.some(Number.isNaN)) {
      return null;
    }

    return parts.reduce((total, part) => total * 60 + part, 0);
  };

  const formatDuration = (totalSeconds) => {
    const safeTotalSeconds = Math.max(0, totalSeconds);
    const hours = Math.floor(safeTotalSeconds / 3600);
    const minutes = Math.floor((safeTotalSeconds % 3600) / 60);
    const seconds = safeTotalSeconds % 60;

    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  };

  const getBookDurationSeconds = () => {
    const labels = [...document.querySelectorAll(BOOK_INFO_LABEL_SELECTOR)];
    const durationLabel = labels.find((label) => label.textContent.trim().startsWith('Время звучания'));
    const durationText = durationLabel?.parentElement?.textContent.replace(durationLabel.textContent, '').trim();

    return durationText ? parseTimeToSeconds(durationText) : null;
  };

  const cacheBookDuration = () => {
    if (state.bookDurationSeconds !== null) {
      return;
    }

    const bookDurationSeconds = getBookDurationSeconds();
    if (bookDurationSeconds !== null) {
      state.bookDurationSeconds = bookDurationSeconds;
    }
  };

  const parsePlaylistItem = (item, index) => {
    const name = item.querySelector('.book_playlist_item_name')?.textContent.trim() || '';
    const displayedTime = item.querySelector('.book_playlist_item_time')?.textContent.trim() || '';
    const isActive = item.classList.contains('-active');

    return {
      index,
      key: getChapterKey(item, index),
      id: item.id || '',
      name,
      displayedTime,
      displayedTimeSeconds: parseTimeToSeconds(displayedTime),
      isActive,
    };
  };

  const collectPlaylistData = () => {
    const items = [...document.querySelectorAll(`${PLAYLIST_SELECTOR} ${PLAYLIST_ITEM_SELECTOR}`)].map(parsePlaylistItem);
    const activeItem = items.find((item) => item.isActive) || null;

    return {
      items,
      activeItem,
    };
  };

  const rememberChapterDurations = ({ items, activeItem }) => {
    items.forEach((item) => {
      if (item.displayedTimeSeconds === null) {
        return;
      }

      if (item.isActive) {
        state.chapterProgressByKey.set(item.key, item.displayedTimeSeconds);
        return;
      }

      if (!state.chapterDurationsByKey.has(item.key)) {
        state.chapterDurationsByKey.set(item.key, item.displayedTimeSeconds);
      }
    });

    state.activeChapterKey = activeItem?.key || null;
  };

  const getChapterDurationSeconds = (item) => {
    if (state.chapterDurationsByKey.has(item.key)) {
      return state.chapterDurationsByKey.get(item.key);
    }

    if (!item.isActive && item.displayedTimeSeconds !== null) {
      return item.displayedTimeSeconds;
    }

    return 0;
  };

  const getTotalPlaybackSeconds = ({ items, activeItem }) => {
    if (!activeItem) {
      return null;
    }

    const previousChaptersSeconds = items
      .slice(0, activeItem.index)
      .reduce((total, item) => total + getChapterDurationSeconds(item), 0);
    const currentChapterProgressSeconds = activeItem.displayedTimeSeconds || 0;

    return previousChaptersSeconds + currentChapterProgressSeconds;
  };

  const renderInfoRow = (labelText, valueText, valueClassName = '') => {
    const row = document.createElement('div');
    row.className = 'ke-player-info-row';

    const label = document.createElement('span');
    label.className = 'ke-player-info-label';
    label.textContent = labelText;

    const value = document.createElement('span');
    value.className = `ke-player-info-value ${valueClassName}`.trim();
    value.textContent = valueText;

    row.append(label, value);
    return row;
  };

  const renderPlaylistInfo = ({ items, activeItem }) => {
    const block = document.getElementById(PLAYER_INFO_BLOCK_ID);
    if (!block) {
      return;
    }

    if (!items.length) {
      block.replaceChildren();
      return;
    }

    const totalPlaybackSeconds = getTotalPlaybackSeconds({ items, activeItem });
    const bookDurationText = state.bookDurationSeconds === null ? '' : ` из ${formatDuration(state.bookDurationSeconds)}`;

    if (!activeItem) {
      block.replaceChildren(renderInfoRow('Глав:', `${items.length}. Активная глава не найдена.`));
      return;
    }

    block.replaceChildren(
      renderInfoRow('Сейчас:', activeItem.name, 'ke-player-info-title'),
      renderInfoRow('Прослушано:', `${formatDuration(totalPlaybackSeconds)}${bookDurationText}`, 'ke-player-info-time'),
    );
  };

  const updatePlaylistInfo = () => {
    cacheBookDuration();

    const playlist = collectPlaylistData();
    if (!playlist.items.length) {
      return false;
    }

    rememberChapterDurations(playlist);
    state.playlist = playlist;
    renderPlaylistInfo(playlist);
    log('playlist processed', playlist);
    return true;
  };

  const schedulePlaylistInfoUpdate = () => {
    if (state.playlistUpdateScheduled) {
      return;
    }

    state.playlistUpdateScheduled = true;
    requestAnimationFrame(() => {
      state.playlistUpdateScheduled = false;
      updatePlaylistInfo();
    });
  };

  const observePlaylistChanges = () => {
    if (state.playlistObserver) {
      return;
    }

    const playlistElement = document.querySelector(PLAYLIST_SELECTOR);
    if (!playlistElement) {
      return;
    }

    state.playlistObserver = new MutationObserver(schedulePlaylistInfoUpdate);
    state.playlistObserver.observe(playlistElement, {
      attributes: true,
      attributeFilter: ['class'],
      characterData: true,
      childList: true,
      subtree: true,
    });
  };

  const waitForPlaylistItems = () => {
    if (updatePlaylistInfo()) {
      observePlaylistChanges();
      return;
    }

    const player = document.querySelector(PLAYER_SELECTOR) || document.documentElement;
    if (!player) {
      return;
    }

    const observer = new MutationObserver(() => {
      if (!updatePlaylistInfo()) {
        return;
      }

      observer.disconnect();
      observePlaylistChanges();
    });

    observer.observe(player, { childList: true, subtree: true });
  };

  const waitForPlayerHead = () => {
    const existingPlayerHead = document.querySelector(PLAYER_HEAD_SELECTOR);
    if (existingPlayerHead) {
      addPlayerInfoBlock(existingPlayerHead);
      waitForPlaylistItems();
      return;
    }

    const root = document.documentElement;
    if (!root) {
      return;
    }

    const observer = new MutationObserver(() => {
      const playerHead = document.querySelector(PLAYER_HEAD_SELECTOR);
      if (!playerHead) {
        return;
      }

      observer.disconnect();
      addPlayerInfoBlock(playerHead);
      waitForPlaylistItems();
    });

    observer.observe(root, { childList: true, subtree: true });
  };

  const init = () => {
    injectStyles();
    waitForPlayerHead();
    log('initialized');
  };

  ready(init);
})();
