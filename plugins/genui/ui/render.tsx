// Maps evaluated UiNodes onto the catalog components. Each component reads
// its props defensively (see values.ts), so a malformed node degrades to an
// Error line instead of breaking the message.
import { Component, useContext, type ComponentType, type ReactNode } from "react";
import type { ComponentName } from "../core/catalog";
import { sourceCaption } from "../core/source";
import type { UiNode } from "../core/types";
import { Acceptance } from "./components/Acceptance";
import { CalendarHeatmap } from "./components/CalendarHeatmap";
import { Benchmark } from "./components/Benchmark";
import { Chart, Sparkline } from "./components/Chart";
import { Changes } from "./components/changes";
import { Code, Diagram, Diff, Snippet } from "./components/code";
import { Commits } from "./components/commits";
import { Compare } from "./components/Compare";
import { Carousel, FollowUps, OptionCards, Swatches } from "./components/choose";
import { Decision, Estimate, Plan } from "./components/decisions";
import { Callout, Icon, KeyValue, Timeline, Tree } from "./components/content";
import { Badge, ErrorLine, File, LoadingPlaceholder, Metric, Progress, Steps, Text } from "./components/display";
import { Dependencies } from "./components/Dependencies";
import { EditableTable } from "./components/EditableTable";
import { Findings } from "./components/Findings";
import { Coverage } from "./components/Coverage";
import { Environments } from "./components/environments";
import { Calendar, List, Walkthrough } from "./components/explain";
import { DateInput, ListEditor, Radio, Rating, Stepper, TextArea } from "./components/fields";
import { Form } from "./components/form";
import { Button, ButtonGroup, Checklist, Choice, Input, Select, Slider, Toggle, type GroupedButton } from "./components/inputs";
import { Card, Details, Divider, Grid, Row, Stack, Tabs } from "./components/layout";
import { Json } from "./components/Json";
import { Logs } from "./components/Logs";
import { MapView } from "./components/Map";
import { Gauge, SegmentedBar } from "./components/meters";
import { Image } from "./components/media";
import { Pipeline } from "./components/Pipeline";
import { Provenance } from "./components/Provenance";
import { PullRequest } from "./components/pullRequest";
import { Entity, Hotspots, Sources } from "./components/references";
import { SourceLine } from "./components/source";
import { Scene } from "./components/Scene";
import { Shader } from "./components/Shader";
import { StackTrace } from "./components/StackTrace";
import { Table } from "./components/Table";
import { Tests } from "./components/Tests";
import { Threads } from "./components/threads";
import { Transcript } from "./components/Transcript";
import { Board, Roadmap, Status } from "./components/tracking";
import { Treemap } from "./components/Treemap";
import { Waterfall } from "./components/Waterfall";
import { Gallery, ImageSearch } from "./components/webMedia";
import { Flashcards, Quiz, Timer } from "./components/widgets";
import { InTableContext, NodeKeyContext } from "./runtime";
import { text, type Props } from "./values";

/** Components that need their node key (NodeKeyContext): a lone Button, and those that ask the user something. */
const KEYED: Partial<Record<ComponentName, true>> = {
  Button: true,
  Form: true,
  Plan: true,
  Decision: true,
  FollowUps: true,
  List: true,
  Findings: true,
  Dependencies: true,
  Pipeline: true,
};

/** Components with a `source:` caption (also the files their data was Loaded from). */
const SOURCED: Partial<Record<ComponentName, true>> = { Table: true, Chart: true, Metric: true };

/** One renderer per catalog component; a catalog entry without one fails to typecheck. */
const RENDERERS = {
  Card,
  Row,
  Stack,
  Grid,
  Tabs,
  Details,
  Divider,
  Text,
  Callout,
  Metric,
  Badge,
  Icon,
  KeyValue,
  Image,
  File,
  Table,
  Chart,
  Sparkline,
  Progress,
  Steps,
  Timeline,
  Tree,
  Code,
  Snippet,
  Diff,
  Diagram,
  Slider,
  Stepper,
  Toggle,
  Choice,
  Radio,
  Select,
  Checklist,
  ListEditor,
  Input,
  TextArea,
  DateInput,
  Rating,
  Button,
  Form,
  Timer,
  Quiz,
  Flashcards,
  Carousel,
  OptionCards,
  Swatches,
  EditableTable,
  FollowUps,
  Entity,
  Sources,
  Hotspots,
  Walkthrough,
  List,
  Calendar,
  Gauge,
  CalendarHeatmap,
  SegmentedBar,
  ImageSearch,
  Gallery,
  Map: MapView,
  Changes,
  Commits,
  PullRequest,
  Threads,
  Tests,
  Json,
  Plan,
  Decision,
  Estimate,
  Environments,
  Board,
  Roadmap,
  Status,
  Findings,
  Coverage,
  Pipeline,
  Dependencies,
  Benchmark,
  Waterfall,
  Treemap,
  Logs,
  StackTrace,
  Compare,
  Provenance,
  Acceptance,
  Transcript,
  Scene,
  Shader,
} satisfies Record<ComponentName, ComponentType<{ props: Props }>>;

/**
 * `captioned: false` leaves out the source line, for a parent that shows one
 * for all its children (a stat strip); a component in a table cell never has
 * one, the table's own says it.
 */
export function RenderNode({ node, captioned = true }: { node: UiNode; captioned?: boolean }): ReactNode {
  const inTable = useContext(InTableContext);
  if (node.type === "Error") return <ErrorLine message={text(node.props.message)} />;
  if (node.type === "Loading") {
    return <LoadingPlaceholder path={text(node.props.path)} component={typeof node.props.component === "string" ? node.props.component : null} />;
  }
  const Renderer: ComponentType<{ props: Props }> = RENDERERS[node.type];
  if (KEYED[node.type]) {
    return (
      <NodeKeyContext value={node.key}>
        <Renderer props={node.props} />
      </NodeKeyContext>
    );
  }
  if (SOURCED[node.type]) {
    // Wrapped with or without a caption, so a `source:` arriving as the reply streams never remounts the component.
    const caption = captioned && !inTable ? sourceCaption(node.props) : null;
    return (
      <div className="flex min-w-0 flex-col gap-1.5">
        <Renderer props={node.props} />
        {caption === null ? null : <SourceLine caption={caption} />}
      </div>
    );
  }
  return <Renderer props={node.props} />;
}

/**
 * Siblings in order. Every run of consecutive Buttons renders as one
 * ButtonGroup (a wrapping row), even a run of one, so a run growing while a
 * reply streams keeps its earlier buttons mounted. `isolate` puts each node
 * (and each grouped button) behind its own NodeBoundary, for the roots.
 */
export function RenderNodes({ nodes, isolate = false }: { nodes: readonly UiNode[]; isolate?: boolean }): ReactNode {
  // A named value used twice under one parent yields the same key twice.
  const seen = new Set<string>();
  const out: ReactNode[] = [];
  let run: GroupedButton[] | null = null;
  nodes.forEach((node, index) => {
    const key = seen.has(node.key) ? `${node.key}@${index}` : node.key;
    seen.add(node.key);
    const element = isolate ? (
      <NodeBoundary key={key} node={node}>
        <RenderNode node={node} />
      </NodeBoundary>
    ) : (
      <RenderNode key={key} node={node} />
    );
    if (node.type !== "Button") {
      run = null;
      out.push(element);
    } else if (run === null) {
      // Keyed by its first button, which stays first as the run grows.
      const buttons: GroupedButton[] = [{ key, props: node.props, element }];
      run = buttons;
      out.push(<ButtonGroup key={`buttons:${key}`} buttons={buttons} />);
    } else {
      run.push({ key, props: node.props, element });
    }
  });
  return out;
}

interface BoundaryProps {
  node: UiNode;
  children: ReactNode;
}

/**
 * Last-resort isolation for one root: a renderer crash shows an Error line
 * for that root only, and the next evaluation (a new node) retries.
 */
export class NodeBoundary extends Component<BoundaryProps, { error: string | null }> {
  override state: { error: string | null } = { error: null };

  static getDerivedStateFromError(cause: unknown): { error: string } {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }

  override componentDidUpdate(previous: BoundaryProps): void {
    if (this.state.error !== null && previous.node !== this.props.node) {
      this.setState({ error: null });
    }
  }

  override render(): ReactNode {
    return this.state.error === null ? (
      this.props.children
    ) : (
      <ErrorLine message={this.state.error} />
    );
  }
}
