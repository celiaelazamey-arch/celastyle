import { StatusBadge } from "../status-badge/StatusBadge";
import { ChevronRightIcon } from "../primitives/icons";
import { cn } from "../lib/cn";
import type { PolicyBranch, PolicyNode, PolicyPanelProps } from "./types";
import "./policy-panel.css";

/**
 * PolicyPanel — the evidence graph and engineering decision tree.
 *
 * An evidence-first OS has to answer "why was this accepted?" without the
 * operator leaving the surface. This renders that reasoning as a set of
 * branches, each a tone-coded badge plus the ordered nodes that justify it.
 */
export function PolicyPanel({
  title = "Policy",
  description,
  branches,
  footer,
  className,
}: PolicyPanelProps) {
  return (
    <aside className={cn("cs-policy", className)} aria-label={title}>
      <header className="cs-policy__header">
        <h2 className="cs-policy__title">{title}</h2>
        {description ? (
          <p className="cs-policy__description">{description}</p>
        ) : null}
      </header>

      <div className="cs-policy__scroll celastyle-scroll">
        {branches.map((branch) => (
          <Branch key={branch.id} branch={branch} />
        ))}
      </div>

      {footer ? <div className="cs-policy__footer">{footer}</div> : null}
    </aside>
  );
}

function Branch({ branch }: { branch: PolicyBranch }) {
  return (
    <section className="cs-branch" aria-label={branch.label}>
      <div className="cs-branch__head">
        <ChevronRightIcon size={12} className="cs-branch__chevron" />
        <StatusBadge tone={branch.tone} variant="subtle">
          {branch.label}
        </StatusBadge>
      </div>

      {branch.rationale ? (
        <p className="cs-branch__rationale">{branch.rationale}</p>
      ) : null}

      {branch.nodes && branch.nodes.length > 0 ? (
        <ol className="cs-node-list">
          {branch.nodes.map((node) => (
            <NodeRow key={node.id} node={node} />
          ))}
        </ol>
      ) : null}
    </section>
  );
}

function NodeRow({ node }: { node: PolicyNode }) {
  const depth = node.depth ?? 0;
  return (
    <li
      className="cs-node"
      data-depth={Math.min(depth, 3)}
      style={depth > 0 ? { paddingLeft: `calc(var(--space-3) * ${depth})` } : undefined}
    >
      <span className="cs-node__rail" aria-hidden="true">
        <span className="cs-node__dot" data-tone={node.tone} />
      </span>
      <div className="cs-node__body">
        <div className="cs-node__label">{node.label}</div>
        {node.detail ? (
          <div className="cs-node__detail">{node.detail}</div>
        ) : null}
        {node.children && node.children.length > 0 ? (
          <ol className="cs-node-list">
            {node.children.map((child) => (
              <NodeRow
                key={child.id}
                node={{ ...child, depth: (child.depth ?? 0) + 1 }}
              />
            ))}
          </ol>
        ) : null}
      </div>
      {node.time ? <span className="cs-node__time">{node.time}</span> : null}
    </li>
  );
}
