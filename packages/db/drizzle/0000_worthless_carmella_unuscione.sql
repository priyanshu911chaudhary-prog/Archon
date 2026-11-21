CREATE TABLE "ingestion_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"bullmq_job_id" text,
	"stage" text NOT NULL,
	"progress_pct" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"error_detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingestion_jobs_stage_check" CHECK ("stage" IN ('queued', 'cloning', 'parsing', 'building_graph', 'ready', 'failed')),
	CONSTRAINT "ingestion_jobs_progress_pct_check" CHECK ("progress_pct" >= 0 AND "progress_pct" <= 100)
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_url" text NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"default_branch" text NOT NULL,
	"commit_sha" text NOT NULL,
	"status" text NOT NULL,
	"embedding_status" text DEFAULT 'pending' NOT NULL,
	"is_sample" boolean DEFAULT false NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"skipped_files_count" integer DEFAULT 0 NOT NULL,
	"size_kb" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_message" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repositories_status_check" CHECK ("status" IN ('queued', 'cloning', 'parsing', 'building_graph', 'ready', 'failed')),
	CONSTRAINT "repositories_embedding_status_check" CHECK ("embedding_status" IN ('pending', 'processing', 'ready', 'degraded', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ingestion_jobs_repo_created" ON "ingestion_jobs" USING btree ("repo_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_repos_active_owner_name_sha" ON "repositories" USING btree ("owner","name","commit_sha") WHERE "status" IN ('queued', 'cloning', 'parsing', 'building_graph', 'ready');