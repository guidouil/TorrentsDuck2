<script lang="ts">
  import { t } from '#lib/i18n.js';
  let { text, title = '', message = '' }: { text: string; title?: string; message?: string } = $props();
  let report = $state<HTMLTextAreaElement>();
  let copied = $state<{ text: string; manual: boolean } | null>(null);

  async function copy() {
    if (!text) return;
    try { await navigator.clipboard.writeText(text); copied = { text, manual: false }; }
    catch { report?.focus(); report?.select(); copied = { text, manual: true }; }
  }
</script>

<section class="panel detection-report" aria-label={title || $t.sourceDiagnostic}>
  <h2>{title || $t.sourceDiagnostic}</h2>
  {#if message}<p>{message}</p>{/if}
  <p class="subtitle">{$t.sourceDiagnosticHelp}</p>
  <label><span class="sr-only">{$t.sourceDiagnostic}</span><textarea bind:this={report} value={text} readonly rows={10} spellcheck="false"></textarea></label>
  <div class="diagnostic-actions"><button type="button" class="secondary" onclick={copy}>{$t.copy}</button><span role="status">{copied?.text === text ? copied.manual ? $t.sourceDiagnosticSelect : $t.sourceDiagnosticCopied : ''}</span></div>
</section>

<style>
  .detection-report{padding:20px;margin-bottom:20px}
  h2{font-size:20px;overflow-wrap:anywhere}
  textarea{width:100%;margin-top:16px;resize:vertical;min-height:160px;font-family:ui-monospace,monospace;font-size:13px;white-space:pre;overflow-wrap:normal}
  .diagnostic-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:12px}
  .diagnostic-actions span{color:var(--muted)}
  @media(max-width:700px){.detection-report{padding:20px 0}}
</style>
