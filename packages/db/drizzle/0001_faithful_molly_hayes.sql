CREATE TABLE "edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"source_node_id" uuid NOT NULL,
	"target_node_id" uuid NOT NULL,
	"edge_type" text NOT NULL,
	"call_site_line" integer,
	"call_site_snippet" text,
	CONSTRAINT "edges_edge_type_check" CHECK ("edge_type" IN ('IMPORTS', 'CALLS')),
	CONSTRAINT "edges_imports_metadata_check" CHECK ("edge_type" <> 'IMPORTS' OR ("call_site_line" IS NULL AND "call_site_snippet" IS NULL AND "source_node_id" <> "target_node_id")),
	CONSTRAINT "edges_calls_metadata_check" CHECK ("edge_type" <> 'CALLS' OR ("call_site_line" IS NOT NULL AND "call_site_line" >= 1 AND "call_site_snippet" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"node_type" text NOT NULL,
	"name" text NOT NULL,
	"qualified_name" text NOT NULL,
	"file_path" text NOT NULL,
	"parent_node_id" uuid,
	"is_exported" boolean DEFAULT false NOT NULL,
	"start_line" integer,
	"end_line" integer,
	"content_hash" text,
	"snippet" text,
	CONSTRAINT "nodes_repo_id_id_unique" UNIQUE("repo_id","id"),
	CONSTRAINT "nodes_repo_id_qualified_name_unique" UNIQUE("repo_id","qualified_name"),
	CONSTRAINT "nodes_node_type_check" CHECK ("node_type" IN ('folder', 'file', 'function', 'class', 'symbol')),
	CONSTRAINT "nodes_qualified_name_check" CHECK (octet_length("qualified_name") >= 1 AND octet_length("qualified_name") <= 2048),
	CONSTRAINT "nodes_no_self_parent_check" CHECK ("parent_node_id" IS NULL OR "parent_node_id" <> "id"),
	CONSTRAINT "nodes_folder_metadata_check" CHECK ("node_type" <> 'folder' OR ("is_exported" = false AND "start_line" IS NULL AND "end_line" IS NULL AND "content_hash" IS NULL AND "snippet" IS NULL)),
	CONSTRAINT "nodes_non_folder_metadata_check" CHECK ("node_type" = 'folder' OR ("start_line" IS NOT NULL AND "end_line" IS NOT NULL AND "start_line" >= 1 AND "end_line" >= "start_line" AND "content_hash" IS NOT NULL AND length("content_hash") = 64 AND "content_hash" ~ '^[0-9a-f]{64}$' AND "snippet" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "repositories" DROP CONSTRAINT "repositories_status_check";--> statement-breakpoint
ALTER TABLE "ingestion_jobs" ADD COLUMN "attempt_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "graph_persisted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_repo_source_node_fk" FOREIGN KEY ("repo_id","source_node_id") REFERENCES "public"."nodes"("repo_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_repo_target_node_fk" FOREIGN KEY ("repo_id","target_node_id") REFERENCES "public"."nodes"("repo_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_repo_parent_fk" FOREIGN KEY ("repo_id","parent_node_id") REFERENCES "public"."nodes"("repo_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_edges_unique_imports" ON "edges" USING btree ("repo_id","source_node_id","target_node_id") WHERE "edge_type" = 'IMPORTS';--> statement-breakpoint
CREATE UNIQUE INDEX "idx_edges_unique_calls" ON "edges" USING btree ("repo_id","source_node_id","target_node_id","call_site_line") WHERE "edge_type" = 'CALLS';--> statement-breakpoint
CREATE INDEX "idx_edges_reverse_lookup" ON "edges" USING btree ("repo_id","target_node_id","edge_type");--> statement-breakpoint
CREATE INDEX "idx_edges_forward_lookup" ON "edges" USING btree ("repo_id","source_node_id","edge_type");--> statement-breakpoint
CREATE INDEX "idx_nodes_repo_parent" ON "nodes" USING btree ("repo_id","parent_node_id");--> statement-breakpoint
CREATE INDEX "idx_nodes_repo_type" ON "nodes" USING btree ("repo_id","node_type");--> statement-breakpoint
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_attempt_generation_check" CHECK ("attempt_generation" >= 0);--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_graph_persisted_at_check" CHECK ("graph_persisted_at" IS NULL OR "status" = 'ready');--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_status_check" CHECK ("status" IN ('queued', 'cloning', 'parsing', 'building_graph', 'ready', 'failed', 'superseded'));