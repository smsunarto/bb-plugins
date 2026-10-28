// The Gen-UI Gallery page (/plugins/genui/gallery): every catalog component
// with the example specs in the plugin's gallery/ folder (gallery/<Component>.ui
// and gallery/<Component>-<variant>.ui), rendered exactly as in a chat reply,
// so components can be checked without a thread. `/gallery/<Component>` shows
// one component, `/gallery/<Component>-<variant>` one example. Picks and
// Form answers only show what they would put in the user's message; there is
// no thread composer to stage them in.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { compile } from "../core";
import { COMPONENTS, type ComponentName } from "../core/catalog";
import type { rpcContract } from "../server";
import type { GalleryExample } from "./FrameFooter";
import { GalleryHeader, groupAnchor, type GallerySelection } from "./GalleryHeader";
import { componentsIn, GALLERY_GROUPS } from "./gallery-search";
import { LiveUi, RenderFailure, type AnswerTarget } from "./LiveUi";
import { useAssetLoader, useAudioLoader, useImageLoader, useLoadedData, useTextLoader } from "./useLoadedData";
import { useMotionScope } from "./components/motion";

const PANEL = "gallery";
const GALLERY_ANSWERS: AnswerTarget = { kind: "gallery" };

type Listing = { status: "loading" } | { status: "failed"; message: string } | { status: "ready"; names: string[] };

function base(file: string): string {
  return file.replace(/\.ui$/, "");
}

function isComponent(name: string): name is ComponentName {
  return Object.hasOwn(COMPONENTS, name);
}

/** "Chart-funnel.ui" → Chart; files named after no component are left out. */
function componentOf(file: string): ComponentName | null {
  const name = base(file).split("-")[0];
  return isComponent(name) ? name : null;
}

/** Each component's example files, the plain one first. */
function examplesByComponent(names: readonly string[]): ReadonlyMap<ComponentName, string[]> {
  const byComponent = new Map<ComponentName, string[]>();
  for (const file of names) {
    const component = componentOf(file);
    if (component === null) continue;
    byComponent.set(component, [...(byComponent.get(component) ?? []), file]);
  }
  for (const files of byComponent.values()) files.sort((a, b) => a.length - b.length || a.localeCompare(b));
  return byComponent;
}

export function GalleryPanel({ subPath }: { subPath: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [listing, setListing] = useState<Listing>({ status: "loading" });
  const [generation, setGeneration] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const motion = useMotionScope();

  useEffect(() => {
    let live = true;
    rpc.call("gallery_list", {}).then(
      ({ names }) => live && setListing({ status: "ready", names }),
      (cause: unknown) => live && setListing({ status: "failed", message: cause instanceof Error ? cause.message : String(cause) }),
    );
    return () => {
      live = false;
    };
  }, [rpc, generation]);

  const names = listing.status === "ready" ? listing.names : [];
  const examples = useMemo(() => examplesByComponent(names), [names]);
  const exampleCount = [...examples.values()].reduce((total, files) => total + files.length, 0);

  // `/gallery/<Component>` shows that component; `/gallery/<file>` one example.
  const selected = subPath === "" ? null : decodeURIComponent(subPath);
  const selectedComponent = selected !== null && isComponent(selected) ? selected : null;
  const selectedFile = selected !== null && selectedComponent === null ? names.find((name) => base(name) === selected) : undefined;
  const fileComponent = selectedFile === undefined ? null : componentOf(selectedFile);
  const selection: GallerySelection =
    selectedComponent !== null
      ? { kind: "component", name: selectedComponent }
      : selectedFile !== undefined && fileComponent !== null
        ? { kind: "example", name: fileComponent, variant: base(selectedFile).slice(fileComponent.length + 1) || "default" }
        : selected === null
          ? { kind: "index" }
          : { kind: "missing", path: selected };

  const go = (path: string) => {
    navigate.toPluginPanel(PANEL, { subPath: path });
    scroller.current?.scrollTo({ top: 0 });
  };

  let body: ReactNode;
  if (listing.status === "loading") body = <Notice>Loading examples…</Notice>;
  else if (listing.status === "failed") body = <Notice>Couldn&apos;t list the examples: {listing.message}</Notice>;
  else if (selectedFile !== undefined) body = <Example key={`${selectedFile}:${generation}`} file={selectedFile} root={scroller} open={null} eager />;
  else if (selectedComponent !== null)
    body = (
      <ComponentSection
        name={selectedComponent}
        files={examples.get(selectedComponent) ?? []}
        generation={generation}
        root={scroller}
        open={(file) => go(base(file))}
        titled={false}
      />
    );
  else if (selected !== null) body = <Notice>No component or example named {selected}.</Notice>;
  else
    body = GALLERY_GROUPS.map((group) => (
      <section key={group} id={groupAnchor(group)} className="flex flex-col gap-8">
        <h2 className="m-0 border-b border-border pb-2 text-sm font-semibold text-foreground">{group}</h2>
        {componentsIn(group).map((name) => (
          <ComponentSection
            key={name}
            name={name}
            files={examples.get(name) ?? []}
            generation={generation}
            root={scroller}
            open={(file) => go(base(file))}
          />
        ))}
      </section>
    ));

  return (
    // BB's page frame doesn't scroll; the page is its own scroll container.
    <div {...motion} ref={scroller} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col px-5 pb-12">
        <GalleryHeader
          selection={selection}
          exampleCount={listing.status === "ready" ? exampleCount : null}
          examples={examples}
          scroller={scroller}
          onGo={go}
          onReload={() => setGeneration((value) => value + 1)}
        />
        <div className="mt-6 flex flex-col gap-10">{body}</div>
      </div>
    </div>
  );
}

/** A component's examples; `titled` names it above them (the index), not on its own page, whose header does. */
function ComponentSection({
  name,
  files,
  generation,
  root,
  open,
  titled = true,
}: {
  name: ComponentName;
  files: readonly string[];
  generation: number;
  root: React.RefObject<HTMLDivElement | null>;
  open: (file: string) => void;
  titled?: boolean;
}) {
  return (
    <section data-gallery-component={name} className="flex flex-col gap-1">
      {titled ? <h3 className="text-sm font-medium text-foreground">{name}</h3> : null}
      {files.length === 0 ? <Notice>No example yet.</Notice> : null}
      <div className="flex flex-col gap-5">
        {files.map((file) => (
          <Example key={`${file}:${generation}`} file={file} root={root} open={() => open(file)} />
        ))}
      </div>
    </section>
  );
}

type Source = { status: "loading" } | { status: "failed"; message: string } | { status: "ready"; source: string };

/** One example; off-screen ones mount once they come near, so "All" stays light. */
function Example({
  file,
  root,
  open,
  eager = false,
}: {
  file: string;
  root: React.RefObject<HTMLDivElement | null>;
  /** Shows this example alone; null where it already is. */
  open: (() => void) | null;
  eager?: boolean;
}) {
  const [near, setNear] = useState(eager);
  const placeholder = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (near || placeholder.current === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { root: root.current, rootMargin: "1200px 0px" },
    );
    observer.observe(placeholder.current);
    return () => observer.disconnect();
  }, [near, root]);

  const name = base(file);
  const dash = name.indexOf("-");
  const example: GalleryExample = {
    file,
    component: dash === -1 ? name : name.slice(0, dash),
    variant: dash === -1 ? null : name.slice(dash + 1),
    open,
  };
  return (
    <div data-gallery-entry={name} className="flex flex-col">
      {near ? <ExampleBody example={example} /> : <div ref={placeholder} className="my-3 h-40 rounded-xl border border-border" />}
    </div>
  );
}

function ExampleBody({ example }: { example: GalleryExample }) {
  const { file } = example;
  const rpc = useRpc<typeof rpcContract>();
  const [source, setSource] = useState<Source>({ status: "loading" });
  useEffect(() => {
    let live = true;
    rpc.call("gallery_get", { name: file }).then(
      (result) => live && setSource({ status: "ready", source: result.source }),
      (cause: unknown) => live && setSource({ status: "failed", message: cause instanceof Error ? cause.message : String(cause) }),
    );
    return () => {
      live = false;
    };
  }, [rpc, file]);

  const text = source.status === "ready" ? source.source : "";
  const compiled = useMemo(() => compile(text), [text]);
  const data = useLoadedData("gallery", compiled.program);
  const loadImage = useImageLoader("gallery");
  const readText = useTextLoader("gallery");
  const loadAudio = useAudioLoader("gallery");
  const loadAsset = useAssetLoader("gallery");

  if (source.status === "loading") return <Notice>Loading…</Notice>;
  if (source.status === "failed") return <Notice>Couldn&apos;t read {file}: {source.message}</Notice>;
  if (compiled.program === null) return <RenderFailure source={text} diagnostics={compiled.diagnostics} gallery={example} />;
  return (
    <LiveUi
      program={compiled.program}
      compileDiagnostics={compiled.diagnostics}
      source={text}
      stateKey={`bb.genui.gallery:${file}`}
      data={data}
      answers={GALLERY_ANSWERS}
      openFile={null}
      loadImage={loadImage}
      readText={readText}
      loadAudio={loadAudio}
      loadAsset={loadAsset}
      threadId={galleryThread()}
      blockKey={null}
      gallery={example}
    />
  );
}

/**
 * The gallery belongs to no thread. Examples of components that read a
 * thread's own state (its checkout's changes, its subthreads) render against
 * the thread named by `?thread=thr_…`, and say they need one otherwise.
 */
function galleryThread(): string | null {
  const id = new URLSearchParams(window.location.search).get("thread");
  return id !== null && /^thr_[a-z0-9]+$/.test(id) ? id : null;
}

function Notice({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground">{children}</p>;
}
