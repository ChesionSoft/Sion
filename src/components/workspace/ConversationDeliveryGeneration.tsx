/** A document-safe adaptation of AIcss's Image Generation motion. It appears
 * only while Sion is genuinely checking, validating, or saving a delivery —
 * the animated field represents a changing draft, never a generated image. */
export function ConversationDeliveryGeneration({ label }: { label: string }) {
  return (
    <section className="conversation-delivery-generation" aria-live="polite">
      <div className="conversation-delivery-generation-canvas" aria-hidden="true">
        <span className="conversation-delivery-generation-dots" />
        <span className="conversation-delivery-generation-glow" />
        <span className="conversation-delivery-generation-page" />
      </div>
      <div>
        <strong>正在准备交付稿</strong>
        <p>{label}</p>
      </div>
    </section>
  );
}
