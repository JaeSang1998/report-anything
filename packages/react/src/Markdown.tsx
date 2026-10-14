import { useMemo } from "react";
import type { ReactNode } from "react";
import { parseMarkdown, renderTemplate } from "@report-anything/core";
import type { DataContext, Inline } from "@report-anything/core";

function inlines(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.type) {
      case "text":
        return n.text;
      case "strong":
        return <strong key={i}>{inlines(n.children)}</strong>;
      case "em":
        return <em key={i}>{inlines(n.children)}</em>;
      case "code":
        return <code key={i}>{n.text}</code>;
    }
  });
}

/** Markdown subset with `{{ agg(dataset.field) | format }}` placeholders resolved from data. */
export function Markdown({ text, context, className }: { text: string; context: DataContext; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(text.includes("{{") ? renderTemplate(text, context).text : text), [text, context]);
  return (
    <div className={className ? `ra-md ${className}` : "ra-md"}>
      {blocks.map((b, i) => {
        switch (b.type) {
          case "paragraph":
            return <p key={i}>{inlines(b.children)}</p>;
          case "heading":
            return <h4 key={i}>{inlines(b.children)}</h4>;
          case "list": {
            const List = b.ordered ? "ol" : "ul";
            return (
              <List key={i}>
                {b.items.map((item, j) => (
                  <li key={j}>{inlines(item)}</li>
                ))}
              </List>
            );
          }
        }
      })}
    </div>
  );
}
