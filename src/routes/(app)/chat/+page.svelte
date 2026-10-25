<script lang="ts">
  import Notification from '#lib/Notification.svelte';
  import Icon from '#lib/Icon.svelte';
  import { onMount, tick } from 'svelte';
  import { api } from '#lib/client.js';
  import { language, t } from '#lib/i18n.js';
  let messages = $state<any[]>([]); let body = $state(''); let error = $state(''); let busy = $state(false); let loading = $state(true); let nextCursor = $state<string | null>(null); let container = $state<HTMLDivElement>();
  async function load(older = false) { try { const result = await api(`/api/chat${older && nextCursor ? `?before=${encodeURIComponent(nextCursor)}` : ''}`); const nearBottom = !container || container.scrollHeight - container.scrollTop - container.clientHeight < 90; if (older) messages = [...result.messages, ...messages]; else { const map = new Map([...messages, ...result.messages].map((x) => [x.id, x])); messages = [...map.values()].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()); } if (older || loading) nextCursor = result.nextCursor; loading = false; if (!older && nearBottom) { await tick(); container?.scrollTo({ top: container.scrollHeight, behavior: 'smooth' }); } } catch (e) { error = (e as Error).message; loading = false; } }
  onMount(() => { void load(); const timer = setInterval(() => { if (!document.hidden) void load(); }, 5000); return () => clearInterval(timer); });
  function shortName(name: string) {
    const characters = Array.from(new Intl.Segmenter().segment(name), ({ segment }) => segment);
    return characters.length > 8 ? characters.slice(0, 7).join('') + '…' : name;
  }
  function keydown(event: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!event.repeat) event.currentTarget.form?.requestSubmit();
  }
  async function send(event: SubmitEvent) { event.preventDefault(); if (busy || !body.trim()) return; busy = true; error = ''; try { await api('/api/chat', { method: 'POST', body: JSON.stringify({ body }) }); body = ''; await load(); await tick(); container?.scrollTo({ top: container.scrollHeight, behavior: 'smooth' }); } catch (e) { error = (e as Error).message; } finally { busy = false; } }
</script>
<svelte:head><title>{$t.chat} · Torrents Duck</title></svelte:head>
<h1 class="sr-only">{$t.chat}</h1>
<Notification bind:message={error} kind="error" />
<section class="panel chat-panel">
  <div class="chat-messages" bind:this={container} aria-label={$t.messages}>
    {#if nextCursor}<button class="quiet-button" onclick={() => load(true)}>{$t.previousMessages}</button>{/if}
    {#if loading}<div class="empty"><p>{$t.loadingPage}</p></div>{:else if !messages.length}<div class="empty"><p>{$t.chatEmpty}</p></div>{/if}
    {#each messages as message, index (message.id)}
      {@const date = new Date(message.createdAt)}
      {#if index === 0 || date.toDateString() !== new Date(messages[index - 1].createdAt).toDateString()}
        <div class="chat-date">{date.toLocaleDateString($language, { dateStyle: 'long' })}</div>
      {/if}
      <article class="chat-entry">
        <time datetime={message.createdAt} title={date.toLocaleString($language)} aria-label={date.toLocaleString($language)}>[{date.toLocaleTimeString($language, { hour: '2-digit', minute: '2-digit', hour12: false })}]</time>
        <strong><span class="chat-name-full" aria-hidden="true">&lt;{message.name}&gt;</span><span class="chat-name-short" aria-hidden="true">&lt;{shortName(message.name)}&gt;</span><span class="sr-only">&lt;{message.name}&gt;</span></strong>
        <p>{message.body}</p>
      </article>
    {/each}
  </div>
  <form class="chat-form" onsubmit={send}>
    <div class="chat-compose">
      <textarea aria-label={$t.message} aria-describedby="chat-keyboard-help" placeholder={$t.message} bind:value={body} onkeydown={keydown} readonly={busy} maxlength={2000} rows="1" required></textarea>
      <small id="chat-keyboard-help">{$t.chatKeyboardHelp}</small>
    </div>
    <button class="primary" disabled={busy || !body.trim()} aria-label={$t.send} title={$t.send}><Icon name="send" size={18} /></button>
  </form>
</section>
