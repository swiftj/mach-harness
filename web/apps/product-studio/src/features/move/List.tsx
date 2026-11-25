import { Text } from "@mach/ui";

/** A titled list of the engine's sentences, as written; nothing at all when it is empty. */
export function List({ title, items, note }: { title: string; items: readonly string[]; note?: string }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <h4 className="text-label text-ink">{title}</h4>
      {note ? (
        <Text size="body-sm" tone="muted" className="max-w-reading">
          {note}
        </Text>
      ) : null}
      <ul className="flex max-w-reading list-disc flex-col gap-1 pl-5 text-body-sm text-ink">
        {items.map((item, index) => (
          <li key={`${index}-${item}`}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
