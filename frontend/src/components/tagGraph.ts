/**
 * Tag graph — architecture §4.
 *
 * A genuine d3-force simulation, not a one-shot layout: repulsion between
 * nodes, spring links whose rest length scales with co-occurrence weight,
 * centre gravity, and collision. Dragging pins a node for the duration of the
 * drag and releases it back into the simulation on drop, so it visibly springs
 * back to equilibrium instead of staying where it was dropped.
 *
 * Clicking a node opens the inline editor; it does *not* navigate away. That
 * split is deliberate — a click that also jumped to the filtered collection
 * meant you could not glance at a tag's metadata without losing your place in
 * the graph.
 */

import { drag as d3drag } from "d3-drag";
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { select, type Selection } from "d3-selection";
import { zoom as d3zoom, zoomIdentity } from "d3-zoom";

import { icon } from "../icons";
import type { GraphEdge, GraphNode } from "../types";
import { el, tagColor } from "../ui";

interface Node extends SimulationNodeDatum, GraphNode {
  radius: number;
}
interface Edge extends SimulationLinkDatum<Node> {
  weight: number;
}

/**
 * The physics knobs exposed in Settings → Tags. Defaults here match
 * `settings_store.DEFAULTS` on the backend — used whenever the caller has no
 * saved preference yet (a fresh install, or while settings are still loading).
 */
export interface TagGraphForces {
  /** Repulsion between nodes; more negative spreads the graph out further. */
  chargeStrength: number;
  /** Base spring length before the per-edge weight discount. */
  linkDistance: number;
  /** How rigidly an edge holds its target distance; low values feel loose. */
  linkStrength: number;
  /** Pull toward the canvas center (via forceX/forceY on each node); higher
   * keeps the graph gathered. Unlike `forceCenter`, this behaves sensibly
   * across its whole range rather than only near 1. */
  centerStrength: number;
}

export const DEFAULT_GRAPH_FORCES: TagGraphForces = {
  chargeStrength: -420,
  linkDistance: 110,
  linkStrength: 0.2,
  // Matches settings_store.DEFAULTS. A tag with no edges at all is held only
  // by this force and pushed only by charge, so it needs to be strong enough
  // on its own — a lower value here let isolated tags drift toward the edge
  // of the canvas with nothing pulling them back.
  centerStrength: 0.1,
};

export interface TagGraphHandle {
  /** Live-update a node after an inline edit, without restarting the layout. */
  updateNode: (
    id: number,
    changes: { name?: string; color?: string | null; category?: GraphNode["category"] },
  ) => void;
  /**
   * Re-tune the running simulation in place — nodes keep their current
   * position, only the forces acting on them change. Used for the settings
   * sliders, where rebuilding the whole graph on every drag tick would be
   * both wasteful and visually jarring (positions and zoom would jump).
   */
  updateForces: (forces: TagGraphForces) => void;
  destroy: () => void;
}

export function renderTagGraph(
  container: HTMLElement,
  data: { nodes: GraphNode[]; edges: GraphEdge[] },
  onSelect: (node: GraphNode) => void,
  forces: TagGraphForces = DEFAULT_GRAPH_FORCES,
): TagGraphHandle {
  container.replaceChildren();
  const width = container.clientWidth || 700;
  const height = container.clientHeight || 460;

  // Node size scales with usage, with a floor so a brand-new tag is still
  // clickable and a ceiling so one dominant tag doesn't swallow the canvas.
  const maxUsage = Math.max(1, ...data.nodes.map((n) => n.usage_count));
  const nodes: Node[] = data.nodes.map((node) => ({
    ...node,
    radius: 12 + 18 * Math.sqrt(node.usage_count / maxUsage),
  }));
  const edges: Edge[] = data.edges.map((edge) => ({
    source: edge.source,
    target: edge.target,
    weight: edge.weight,
  }));

  const svg = select(container)
    .append("svg")
    .attr("width", "100%")
    .attr("height", "100%")
    .attr("viewBox", `0 0 ${width} ${height}`);
  const root = svg.append("g");
  const zoomBehavior = d3zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.4, 3])
    .on("zoom", (event) => root.attr("transform", event.transform.toString()));
  svg.call(zoomBehavior);

  // Recenter — panning/zooming around a few hundred nodes loses you fast,
  // and there was previously no way back to the starting view short of
  // reopening the panel. Resets pan and zoom together, back to identity.
  const recenterBtn = el(
    "button",
    { type: "button", class: "icon-btn graph-recenter-btn", title: "Recenter", "aria-label": "Recenter graph" },
    icon("focus", true),
  );
  recenterBtn.addEventListener("click", () => {
    svg.call(zoomBehavior.transform, zoomIdentity);
  });
  container.append(recenterBtn);

  const simulation: Simulation<Node, Edge> = forceSimulation(nodes)
    .force("charge", forceManyBody().strength(forces.chargeStrength))
    .force(
      "link",
      forceLink<Node, Edge>(edges)
        .id((d) => d.id)
        .distance((d) => Math.max(50, forces.linkDistance - d.weight * 6))
        .strength(forces.linkStrength),
    )
    // A per-node pull toward the middle, not `forceCenter`: that force doesn't
    // pull each node individually — it rigidly re-centers the *average*
    // position of the whole simulation by the same delta every tick. Its
    // strength is only meaningful around 1 (a full correction); above that it
    // overshoots the correction and the layout oscillates instead of settling,
    // which is exactly the "breaks above 1" bug this replaced. forceX/forceY
    // give an actual adjustable spring toward the center, so the slider's
    // whole range behaves.
    .force("x", forceX<Node>(width / 2).strength(forces.centerStrength))
    .force("y", forceY<Node>(height / 2).strength(forces.centerStrength))
    .force(
      "collide",
      forceCollide<Node>().radius((d) => d.radius + 20),
    )
    .alphaDecay(0.01)
    .velocityDecay(0.32);

  const link = root
    .append("g")
    .selectAll<SVGLineElement, Edge>("line")
    .data(edges)
    .join("line")
    .attr("stroke", "#999")
    .attr("stroke-opacity", 0.45)
    // Fixed width for every edge — weight already reads through the layout
    // itself (a lower rest length pulls heavier pairs closer together), so
    // varying thickness on top of that was redundant and read as inconsistent
    // rather than meaningful.
    .attr("stroke-width", 1.5);

  const node: Selection<SVGGElement, Node, SVGGElement, unknown> = root
    .append("g")
    .selectAll<SVGGElement, Node>("g")
    .data(nodes)
    .join("g")
    .attr("class", "graph-node")
    .style("cursor", "pointer");

  node
    .append("circle")
    .attr("r", (d) => d.radius)
    .attr("fill", (d) => tagColor(d));
  node
    .append("text")
    .text((d) => d.name)
    .attr("dy", (d) => d.radius + 13)
    .attr("text-anchor", "middle");

  let wasDragged = false;
  node.call(
    d3drag<SVGGElement, Node>()
      .on("start", (event, d) => {
        wasDragged = false;
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on("drag", (event, d) => {
        wasDragged = true;
        d.fx = event.x;
        d.fy = event.y;
      })
      .on("end", (event, d) => {
        if (!event.active) simulation.alphaTarget(0.02);
        d.fx = null;
        d.fy = null;
      }),
  );

  node.on("click", (_event, d) => {
    if (!wasDragged) onSelect(d);
  });

  node
    .on("mouseenter", (_event, d) => {
      const neighbours = new Set<number>([d.id]);
      for (const edge of edges) {
        const source = edge.source as Node;
        const target = edge.target as Node;
        if (source.id === d.id) neighbours.add(target.id);
        if (target.id === d.id) neighbours.add(source.id);
      }
      node.style("opacity", (n) => (neighbours.has(n.id) ? 1 : 0.15));
      link.style("opacity", (l) =>
        (l.source as Node).id === d.id || (l.target as Node).id === d.id ? 0.9 : 0.05,
      );
    })
    .on("mouseleave", () => {
      node.style("opacity", 1);
      link.style("opacity", 0.45);
    });

  simulation.on("tick", () => {
    link
      .attr("x1", (d) => (d.source as Node).x ?? 0)
      .attr("y1", (d) => (d.source as Node).y ?? 0)
      .attr("x2", (d) => (d.target as Node).x ?? 0)
      .attr("y2", (d) => (d.target as Node).y ?? 0);
    node.attr("transform", (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
  });

  // A low, non-zero alpha nudged on a slow interval keeps a faint idle drift, so
  // the graph reads as alive rather than as a frozen diagram once it settles.
  const idle = window.setInterval(() => {
    simulation.alphaTarget(0.025);
    window.setTimeout(() => simulation.alphaTarget(0), 900);
  }, 5000);

  return {
    updateNode(id, changes) {
      const target = nodes.find((n) => n.id === id);
      if (!target) return;
      if (changes.name !== undefined) target.name = changes.name;
      if (changes.color !== undefined) target.color = changes.color;
      if (changes.category !== undefined) target.category = changes.category;
      node
        .filter((n) => n.id === id)
        .select("text")
        .text(target.name);
      node
        .filter((n) => n.id === id)
        .select("circle")
        .attr("fill", tagColor(target));
    },
    updateForces(next) {
      simulation.force("charge", forceManyBody().strength(next.chargeStrength));
      simulation.force(
        "link",
        forceLink<Node, Edge>(edges)
          .id((d) => d.id)
          .distance((d) => Math.max(50, next.linkDistance - d.weight * 6))
          .strength(next.linkStrength),
      );
      simulation.force("x", forceX<Node>(width / 2).strength(next.centerStrength));
      simulation.force("y", forceY<Node>(height / 2).strength(next.centerStrength));
      // A gentle nudge, not a full restart: the point of tuning forces is to
      // watch the *current* layout relax into the new feel, not to reshuffle
      // node positions from scratch on every slider tick.
      simulation.alpha(0.3).restart();
    },
    destroy() {
      window.clearInterval(idle);
      simulation.stop();
      container.replaceChildren();
    },
  };
}
