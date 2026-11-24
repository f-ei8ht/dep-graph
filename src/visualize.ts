import { writeFileSync } from "fs";
import { DependencyGraph } from "./types.js";

/**
 * Generates a self-contained interactive HTML visualization of the tool dependency graph
 * using Cytoscape.js with service color coding, search, service filter, and click-to-highlight neighbors.
 */
export function writeVisualization(graph: DependencyGraph, outPath = "graph.html"): void {
  const connectedIds = new Set<string>();
  for (const e of graph.edges) {
    connectedIds.add(e.from);
    connectedIds.add(e.to);
  }

  const services = [...new Set(graph.nodes.map((n) => n.service ?? "general"))].sort();

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Tool Dependency Graph Visualization</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.28.1/cytoscape.min.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      display: flex;
      height: 100vh;
      overflow: hidden;
    }
    #sidebar {
      width: 340px;
      background: #1e293b;
      border-right: 1px solid #334155;
      display: flex;
      flex-direction: column;
      padding: 16px;
      gap: 14px;
      overflow-y: auto;
      z-index: 10;
    }
    h1 { font-size: 18px; font-weight: 700; color: #f8fafc; }
    .stats {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
      background: #0f172a;
      padding: 10px;
      border-radius: 8px;
      border: 1px solid #334155;
    }
    .stat { text-align: center; }
    .stat-val { font-size: 18px; font-weight: 700; color: #38bdf8; }
    .stat-lbl { font-size: 11px; color: #94a3b8; text-transform: uppercase; }
    label { font-size: 12px; font-weight: 600; color: #94a3b8; display: block; margin-bottom: 4px; }
    input, select, button {
      width: 100%;
      padding: 8px 10px;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 6px;
      color: #f8fafc;
      font-size: 13px;
    }
    button {
      background: #2563eb;
      border-color: #3b82f6;
      cursor: pointer;
      font-weight: 600;
      transition: background 0.15s;
    }
    button:hover { background: #1d4ed8; }
    .btn-row { display: flex; gap: 8px; }
    #details {
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 8px;
      padding: 12px;
      font-size: 12px;
      line-height: 1.5;
      flex: 1;
      overflow-y: auto;
    }
    #details h3 { font-size: 13px; color: #38bdf8; margin-bottom: 6px; word-break: break-all; }
    .edge-item {
      padding: 4px 6px;
      margin: 4px 0;
      background: #1e293b;
      border-radius: 4px;
      border-left: 3px solid #38bdf8;
      word-break: break-all;
    }
    .badge {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 4px;
      background: #334155;
      color: #f8fafc;
      font-family: monospace;
      font-size: 11px;
    }
    #cy { flex: 1; height: 100vh; }
  </style>
</head>
<body>
  <div id="sidebar">
    <h1>Tool Dependency Graph</h1>
    <div class="stats">
      <div class="stat">
        <div class="stat-val" id="stat-nodes">${graph.nodes.length}</div>
        <div class="stat-lbl">Total Tools</div>
      </div>
      <div class="stat">
        <div class="stat-val" id="stat-connected">${connectedIds.size}</div>
        <div class="stat-lbl">Connected</div>
      </div>
      <div class="stat">
        <div class="stat-val" id="stat-edges">${graph.edges.length}</div>
        <div class="stat-lbl">Edges</div>
      </div>
    </div>

    <div>
      <label for="search">Search Tool Slug or Parameter Label</label>
      <input id="search" type="text" placeholder="e.g. ISSUE_COMMENT or pull_number..." />
    </div>

    <div>
      <label for="service-filter">Filter by Service</label>
      <select id="service-filter">
        <option value="ALL">All Connected Tools (${connectedIds.size})</option>
        <option value="ALL_WITH_ISOLATED">All Tools Including Isolated (${graph.nodes.length})</option>
        ${services.map((s) => `<option value="${s}">${s}</option>`).join("\n        ")}
      </select>
    </div>

    <div class="btn-row">
      <button id="btn-reset">Reset View</button>
      <button id="btn-examples">Show Key Examples</button>
    </div>

    <div id="details">
      <h3>Click a node or edge</h3>
      <p style="color:#94a3b8;">Select any tool node to inspect its incoming precursor dependencies (producers) and outgoing consumers.</p>
    </div>
  </div>
  <div id="cy"></div>

  <script>
    const GRAPH_DATA = ${JSON.stringify(graph)};

    const PALETTE = [
      "#38bdf8", "#34d399", "#f472b6", "#fbbf24", "#a78bfa",
      "#fb7185", "#2dd4bf", "#60a5fa", "#f97316", "#c084fc"
    ];
    const serviceColors = {};
    const services = [...new Set(GRAPH_DATA.nodes.map(n => n.service || "general"))].sort();
    services.forEach((s, i) => { serviceColors[s] = PALETTE[i % PALETTE.length]; });

    const cy = cytoscape({
      container: document.getElementById("cy"),
      elements: [],
      style: [
        {
          selector: "node",
          style: {
            "background-color": "data(color)",
            "label": "data(shortLabel)",
            "color": "#f8fafc",
            "font-size": "10px",
            "text-valign": "bottom",
            "text-margin-y": 4,
            "width": "data(size)",
            "height": "data(size)",
            "border-width": 2,
            "border-color": "#0f172a"
          }
        },
        {
          selector: "edge",
          style: {
            "width": 1.6,
            "line-color": "#475569",
            "target-arrow-color": "#38bdf8",
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
            "label": "data(label)",
            "font-size": "9px",
            "color": "#94a3b8",
            "text-rotation": "autorotate",
            "text-background-opacity": 0.85,
            "text-background-color": "#0f172a",
            "text-background-padding": "2px"
          }
        },
        {
          selector: ".highlighted",
          style: {
            "border-color": "#ffffff",
            "border-width": 3,
            "line-color": "#38bdf8",
            "target-arrow-color": "#38bdf8",
            "width": 2.8,
            "z-index": 99
          }
        },
        {
          selector: ".dimmed",
          style: {
            "opacity": 0.15
          }
        }
      ]
    });

    const degreeMap = {};
    GRAPH_DATA.edges.forEach(e => {
      degreeMap[e.from] = (degreeMap[e.from] || 0) + 1;
      degreeMap[e.to] = (degreeMap[e.to] || 0) + 1;
    });

    function renderSubgraph(filterService, query, showIsolated = false) {
      const q = (query || "").trim().toUpperCase();
      const matchedEdges = GRAPH_DATA.edges.filter(e => {
        if (q) {
          return e.from.toUpperCase().includes(q) ||
                 e.to.toUpperCase().includes(q) ||
                 (e.label || "").toUpperCase().includes(q);
        }
        return true;
      });

      const nodeById = {};
      GRAPH_DATA.nodes.forEach(n => { nodeById[n.id] = n; });

      const activeNodeIds = new Set();
      const finalEdges = [];

      matchedEdges.forEach((e, idx) => {
        const nFrom = nodeById[e.from];
        const nTo = nodeById[e.to];
        if (!nFrom || !nTo) return;
        if (filterService && filterService !== "ALL" && filterService !== "ALL_WITH_ISOLATED") {
          if (nFrom.service !== filterService && nTo.service !== filterService) return;
        }
        activeNodeIds.add(e.from);
        activeNodeIds.add(e.to);
        finalEdges.push({
          data: {
            id: "e_" + idx,
            source: e.from,
            target: e.to,
            label: e.label || ""
          }
        });
      });

      if (showIsolated || q) {
        GRAPH_DATA.nodes.forEach(n => {
          if (q && !n.id.toUpperCase().includes(q)) return;
          if (filterService && filterService !== "ALL" && filterService !== "ALL_WITH_ISOLATED" && n.service !== filterService) return;
          activeNodeIds.add(n.id);
        });
      }

      const finalNodes = [...activeNodeIds].map(id => {
        const n = nodeById[id] || { id, service: "general" };
        const deg = degreeMap[id] || 1;
        return {
          data: {
            id: n.id,
            service: n.service || "general",
            shortLabel: n.id.replace(/^[A-Z]+_/, ""),
            color: serviceColors[n.service || "general"] || "#38bdf8",
            size: Math.min(42, 16 + Math.sqrt(deg) * 4)
          }
        };
      });

      cy.elements().remove();
      cy.add([...finalNodes, ...finalEdges]);
      cy.layout({
        name: finalNodes.length > 120 ? "cose" : "breadthfirst",
        directed: true,
        padding: 30,
        animate: false,
        spacingFactor: 1.25
      }).run();
    }

    cy.on("tap", "node", evt => {
      const node = evt.target;
      const neighborhood = node.closedNeighborhood();
      cy.elements().addClass("dimmed").removeClass("highlighted");
      neighborhood.removeClass("dimmed").addClass("highlighted");

      const incoming = node.incomers("edge").map(e => ({
        from: e.source().id(),
        label: e.data("label")
      }));
      const outgoing = node.outgoers("edge").map(e => ({
        to: e.target().id(),
        label: e.data("label")
      }));

      document.getElementById("details").innerHTML = \`
        <h3>\${node.id()}</h3>
        <p style="margin-bottom:8px;">Service: <span class="badge">\${node.data("service")}</span></p>
        <p><strong>Needs from Producers (\${incoming.length}):</strong></p>
        \${incoming.map(i => \`<div class="edge-item"><span class="badge">\${i.label}</span> &larr; \${i.from}</div>\`).join("") || "<p style='color:#64748b'>None (can run directly)</p>"}
        <p style="margin-top:10px;"><strong>Supplies to Consumers (\${outgoing.length}):</strong></p>
        \${outgoing.map(o => \`<div class="edge-item"><span class="badge">\${o.label}</span> &rarr; \${o.to}</div>\`).join("") || "<p style='color:#64748b'>None</p>"}
      \`;
    });

    cy.on("tap", evt => {
      if (evt.target === cy) {
        cy.elements().removeClass("dimmed").removeClass("highlighted");
      }
    });

    const searchInput = document.getElementById("search");
    const serviceSelect = document.getElementById("service-filter");

    function updateFilter() {
      const srv = serviceSelect.value;
      renderSubgraph(srv, searchInput.value, srv === "ALL_WITH_ISOLATED");
    }

    searchInput.addEventListener("input", updateFilter);
    serviceSelect.addEventListener("change", updateFilter);

    document.getElementById("btn-reset").addEventListener("click", () => {
      searchInput.value = "";
      serviceSelect.value = "ALL";
      updateFilter();
    });

    document.getElementById("btn-examples").addEventListener("click", () => {
      searchInput.value = "PULL_NUMBER";
      serviceSelect.value = "ALL";
      renderSubgraph("ALL", "issue_number");
      // Show both issue_number and pull_number examples
      const exampleEdges = GRAPH_DATA.edges.filter(
        e => e.label === "issue_number" || e.label === "pull_number"
      );
      const nodeIds = new Set();
      exampleEdges.forEach(e => { nodeIds.add(e.from); nodeIds.add(e.to); });
      const nodeById = {};
      GRAPH_DATA.nodes.forEach(n => { nodeById[n.id] = n; });
      cy.elements().remove();
      cy.add([
        ...[...nodeIds].map(id => ({
          data: {
            id,
            service: (nodeById[id] && nodeById[id].service) || "general",
            shortLabel: id.replace(/^GITHUB_/, ""),
            color: serviceColors[(nodeById[id] && nodeById[id].service) || "general"] || "#38bdf8",
            size: 26
          }
        })),
        ...exampleEdges.map((e, i) => ({
          data: { id: "ex_" + i, source: e.from, target: e.to, label: e.label }
        }))
      ]);
      cy.layout({ name: "breadthfirst", directed: true, padding: 30, spacingFactor: 1.4 }).run();
    });

    renderSubgraph("ALL", "", false);
  </script>
</body>
</html>`;

  writeFileSync(outPath, html, "utf-8");
}
