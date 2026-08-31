CREATE TABLE "accounts" (
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "accounts_pkey" PRIMARY KEY("provider","provider_account_id")
);
--> statement-breakpoint
CREATE TABLE "cameras" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"operator_name" text NOT NULL,
	"connector_id" uuid,
	"jurisdiction" text NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"location_label" text NOT NULL,
	"view_kind" text NOT NULL,
	"source_url" text NOT NULL,
	"embed_url" text,
	"embed_permitted" boolean DEFAULT false NOT NULL,
	"embed_notes" text,
	"attribution" text,
	"last_verified_at" timestamp with time zone,
	"confidence" text DEFAULT 'needsReview' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"updated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cameras_slug_key" UNIQUE("slug"),
	CONSTRAINT "cameras_view_kind_check" CHECK (view_kind in ('traffic', 'transport', 'tourism')),
	CONSTRAINT "cameras_status_check" CHECK (status in ('draft', 'published')),
	CONSTRAINT "cameras_confidence_check" CHECK (confidence in ('verified', 'high', 'medium', 'needsReview')),
	CONSTRAINT "cameras_latitude_check" CHECK (latitude between -90 and 90),
	CONSTRAINT "cameras_longitude_check" CHECK (longitude between -180 and 180),
	CONSTRAINT "cameras_published_requires_verification_check" CHECK (status <> 'published' or (last_verified_at is not null and embed_notes is not null)),
	CONSTRAINT "cameras_embed_url_check" CHECK (embed_permitted = false or embed_url is not null),
	CONSTRAINT "cameras_embed_requires_connector_check" CHECK (status <> 'published' or embed_permitted = false or connector_id is not null)
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_slug_key" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "connector_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connector_id" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"upstream_status" integer,
	"actor_key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "connector_requests_outcome_check" CHECK (outcome in ('ok', 'upstreamError', 'quotaDenied', 'disabled', 'timeout')),
	CONSTRAINT "connector_requests_duration_check" CHECK (duration_ms >= 0),
	CONSTRAINT "connector_requests_upstream_status_check" CHECK (upstream_status is null or upstream_status between 100 and 599),
	CONSTRAINT "connector_requests_actor_key_check" CHECK (actor_key ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "connectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"operator_name" text NOT NULL,
	"homepage_url" text NOT NULL,
	"terms_url" text,
	"attribution" text,
	"attribution_required" boolean DEFAULT true NOT NULL,
	"legal_basis" text,
	"base_url" text NOT NULL,
	"requires_api_key" boolean DEFAULT false NOT NULL,
	"api_key_env_var" text,
	"per_user_quota" integer NOT NULL,
	"global_ceiling" integer NOT NULL,
	"window_seconds" integer NOT NULL,
	"timeout_ms" integer NOT NULL,
	"cache_ttl_seconds" integer NOT NULL,
	"stale_while_revalidate_seconds" integer NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"last_checked_at" timestamp with time zone,
	"notes" text,
	"updated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connectors_slug_key" UNIQUE("slug"),
	CONSTRAINT "connectors_kind_check" CHECK (kind in ('flights', 'cameras')),
	CONSTRAINT "connectors_status_check" CHECK (status in ('draft', 'published')),
	CONSTRAINT "connectors_published_requires_legal_basis_check" CHECK (status <> 'published' or (terms_url is not null and legal_basis is not null and last_checked_at is not null)),
	CONSTRAINT "connectors_attribution_check" CHECK (attribution_required = false or attribution is not null),
	CONSTRAINT "connectors_api_key_env_var_check" CHECK ((requires_api_key = false or api_key_env_var is not null) and (api_key_env_var is null or api_key_env_var ~ '^[A-Z][A-Z0-9_]*$')),
	CONSTRAINT "connectors_quota_check" CHECK (per_user_quota > 0 and global_ceiling >= per_user_quota and window_seconds > 0 and timeout_ms > 0),
	CONSTRAINT "connectors_cache_check" CHECK (cache_ttl_seconds >= 0 and stale_while_revalidate_seconds >= 0)
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_item_id" uuid,
	"playbook_step_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playbook_step_tools" (
	"step_id" uuid NOT NULL,
	"tool_id" uuid NOT NULL,
	"note" text,
	"order_index" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "playbook_step_tools_pkey" PRIMARY KEY("step_id","tool_id")
);
--> statement-breakpoint
CREATE TABLE "playbook_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"playbook_id" uuid NOT NULL,
	"order_index" integer NOT NULL,
	"title" text NOT NULL,
	"objective" text NOT NULL,
	"body" text NOT NULL,
	"done_when" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playbook_steps_order_index_check" CHECK (order_index >= 0)
);
--> statement-breakpoint
CREATE TABLE "playbooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"overview" text,
	"category_id" uuid NOT NULL,
	"difficulty" text NOT NULL,
	"estimated_minutes" integer NOT NULL,
	"last_verified_at" timestamp with time zone,
	"confidence" text DEFAULT 'needsReview' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"search_keywords" text DEFAULT '' NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(summary, '')), 'B') || setweight(to_tsvector('english', coalesce(search_keywords, '')), 'C') || setweight(to_tsvector('english', coalesce(overview, '')), 'D')) STORED,
	"updated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playbooks_slug_key" UNIQUE("slug"),
	CONSTRAINT "playbooks_status_check" CHECK (status in ('draft', 'published')),
	CONSTRAINT "playbooks_difficulty_check" CHECK (difficulty in ('beginner', 'intermediate', 'advanced')),
	CONSTRAINT "playbooks_confidence_check" CHECK (confidence in ('verified', 'high', 'medium', 'needsReview')),
	CONSTRAINT "playbooks_estimated_minutes_check" CHECK (estimated_minutes > 0),
	CONSTRAINT "playbooks_published_requires_verification_check" CHECK (status <> 'published' or last_verified_at is not null)
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "rate_limits_pkey" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tool_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"rating" integer NOT NULL,
	"body" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"moderated_by_id" uuid,
	"moderated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_status_check" CHECK (status in ('pending', 'approved', 'rejected')),
	CONSTRAINT "reviews_rating_range_check" CHECK (rating between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"session_token" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_slug_key" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "tool_tags" (
	"tool_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "tool_tags_pkey" PRIMARY KEY("tool_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "tools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"summary" text NOT NULL,
	"description" text NOT NULL,
	"category_id" uuid NOT NULL,
	"input_types" text[] DEFAULT '{}'::text[] NOT NULL,
	"output_types" text[] DEFAULT '{}'::text[] NOT NULL,
	"cost_model" text NOT NULL,
	"cost_notes" text,
	"jurisdiction" text,
	"legal_notes" text,
	"last_verified_at" timestamp with time zone,
	"reliability" integer,
	"reliability_notes" text,
	"confidence" text DEFAULT 'needsReview' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"search_keywords" text DEFAULT '' NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(name, '')), 'A') || setweight(to_tsvector('english', coalesce(summary, '')), 'B') || setweight(to_tsvector('english', coalesce(search_keywords, '')), 'C') || setweight(to_tsvector('english', coalesce(description, '')), 'D')) STORED,
	"updated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tools_slug_key" UNIQUE("slug"),
	CONSTRAINT "tools_status_check" CHECK (status in ('draft', 'published')),
	CONSTRAINT "tools_cost_model_check" CHECK (cost_model in ('free', 'freeWithRegistration', 'freemium', 'paid', 'subscription', 'enterprise')),
	CONSTRAINT "tools_confidence_check" CHECK (confidence in ('verified', 'high', 'medium', 'needsReview')),
	CONSTRAINT "tools_reliability_range_check" CHECK (reliability is null or reliability between 1 and 5),
	CONSTRAINT "tools_published_requires_verification_check" CHECK (status <> 'published' or (last_verified_at is not null and reliability is not null))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text,
	"email" text,
	"email_verified" timestamp with time zone,
	"image" text,
	"role" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_key" UNIQUE("email"),
	CONSTRAINT "users_role_check" CHECK (role in ('user', 'editor', 'admin'))
);
--> statement-breakpoint
CREATE TABLE "verification_tokens" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	CONSTRAINT "verification_tokens_pkey" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
CREATE TABLE "workspace_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"tool_id" uuid,
	"step_id" uuid,
	"title" text NOT NULL,
	"order_index" integer DEFAULT 0 NOT NULL,
	"checked" boolean DEFAULT false NOT NULL,
	"checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_items_kind_check" CHECK (kind in ('tool', 'checklistStep')),
	CONSTRAINT "workspace_items_order_index_check" CHECK (order_index >= 0)
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"playbook_id" uuid,
	"title" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_status_check" CHECK (status in ('active', 'completed', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cameras" ADD CONSTRAINT "cameras_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cameras" ADD CONSTRAINT "cameras_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_requests" ADD CONSTRAINT "connector_requests_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_workspace_item_id_workspace_items_id_fk" FOREIGN KEY ("workspace_item_id") REFERENCES "public"."workspace_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_playbook_step_id_playbook_steps_id_fk" FOREIGN KEY ("playbook_step_id") REFERENCES "public"."playbook_steps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_step_tools" ADD CONSTRAINT "playbook_step_tools_step_id_playbook_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."playbook_steps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_step_tools" ADD CONSTRAINT "playbook_step_tools_tool_id_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_steps" ADD CONSTRAINT "playbook_steps_playbook_id_playbooks_id_fk" FOREIGN KEY ("playbook_id") REFERENCES "public"."playbooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbooks" ADD CONSTRAINT "playbooks_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbooks" ADD CONSTRAINT "playbooks_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_tool_id_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_moderated_by_id_users_id_fk" FOREIGN KEY ("moderated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_tags" ADD CONSTRAINT "tool_tags_tool_id_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_tags" ADD CONSTRAINT "tool_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tools" ADD CONSTRAINT "tools_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tools" ADD CONSTRAINT "tools_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_items" ADD CONSTRAINT "workspace_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_items" ADD CONSTRAINT "workspace_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_items" ADD CONSTRAINT "workspace_items_tool_id_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_items" ADD CONSTRAINT "workspace_items_step_id_playbook_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."playbook_steps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_playbook_id_playbooks_id_fk" FOREIGN KEY ("playbook_id") REFERENCES "public"."playbooks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_id_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "cameras_status_name_idx" ON "cameras" USING btree ("status","name");--> statement-breakpoint
CREATE INDEX "cameras_status_jurisdiction_idx" ON "cameras" USING btree ("status","jurisdiction","name");--> statement-breakpoint
CREATE INDEX "cameras_status_view_kind_idx" ON "cameras" USING btree ("status","view_kind","name");--> statement-breakpoint
CREATE INDEX "cameras_connector_id_idx" ON "cameras" USING btree ("connector_id");--> statement-breakpoint
CREATE INDEX "cameras_confidence_verified_idx" ON "cameras" USING btree ("confidence","last_verified_at" NULLS FIRST);--> statement-breakpoint
CREATE INDEX "cameras_updated_by_id_idx" ON "cameras" USING btree ("updated_by_id");--> statement-breakpoint
CREATE INDEX "categories_sort_order_idx" ON "categories" USING btree ("sort_order","name");--> statement-breakpoint
CREATE INDEX "connector_requests_connector_time_idx" ON "connector_requests" USING btree ("connector_id","requested_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "connector_requests_outcome_time_idx" ON "connector_requests" USING btree ("outcome","requested_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "connector_requests_expires_at_idx" ON "connector_requests" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "connectors_kind_status_enabled_idx" ON "connectors" USING btree ("kind","status","enabled");--> statement-breakpoint
CREATE INDEX "connectors_updated_by_id_idx" ON "connectors" USING btree ("updated_by_id");--> statement-breakpoint
CREATE INDEX "notes_workspace_created_idx" ON "notes" USING btree ("workspace_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notes_user_id_idx" ON "notes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notes_workspace_item_id_idx" ON "notes" USING btree ("workspace_item_id");--> statement-breakpoint
CREATE INDEX "notes_playbook_step_id_idx" ON "notes" USING btree ("playbook_step_id");--> statement-breakpoint
CREATE INDEX "playbook_step_tools_tool_id_idx" ON "playbook_step_tools" USING btree ("tool_id");--> statement-breakpoint
CREATE INDEX "playbook_step_tools_step_order_idx" ON "playbook_step_tools" USING btree ("step_id","order_index");--> statement-breakpoint
CREATE INDEX "playbook_steps_playbook_order_idx" ON "playbook_steps" USING btree ("playbook_id","order_index");--> statement-breakpoint
CREATE INDEX "playbooks_search_vector_idx" ON "playbooks" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "playbooks_status_title_idx" ON "playbooks" USING btree ("status","title");--> statement-breakpoint
CREATE INDEX "playbooks_status_category_idx" ON "playbooks" USING btree ("status","category_id","title");--> statement-breakpoint
CREATE INDEX "playbooks_status_difficulty_idx" ON "playbooks" USING btree ("status","difficulty","title");--> statement-breakpoint
CREATE INDEX "playbooks_status_published_at_idx" ON "playbooks" USING btree ("status","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "playbooks_confidence_verified_idx" ON "playbooks" USING btree ("confidence","last_verified_at" NULLS FIRST);--> statement-breakpoint
CREATE INDEX "playbooks_updated_by_id_idx" ON "playbooks" USING btree ("updated_by_id");--> statement-breakpoint
CREATE INDEX "rate_limits_expires_at_idx" ON "rate_limits" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_tool_user_unique_idx" ON "reviews" USING btree ("tool_id","user_id");--> statement-breakpoint
CREATE INDEX "reviews_tool_status_idx" ON "reviews" USING btree ("tool_id","status");--> statement-breakpoint
CREATE INDEX "reviews_status_created_idx" ON "reviews" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires");--> statement-breakpoint
CREATE INDEX "tags_name_idx" ON "tags" USING btree ("name");--> statement-breakpoint
CREATE INDEX "tool_tags_tag_id_idx" ON "tool_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "tools_search_vector_idx" ON "tools" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "tools_input_types_idx" ON "tools" USING gin ("input_types");--> statement-breakpoint
CREATE INDEX "tools_output_types_idx" ON "tools" USING gin ("output_types");--> statement-breakpoint
CREATE INDEX "tools_status_name_idx" ON "tools" USING btree ("status","name");--> statement-breakpoint
CREATE INDEX "tools_status_category_idx" ON "tools" USING btree ("status","category_id","name");--> statement-breakpoint
CREATE INDEX "tools_status_published_at_idx" ON "tools" USING btree ("status","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tools_status_reliability_idx" ON "tools" USING btree ("status","reliability" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tools_status_cost_model_idx" ON "tools" USING btree ("status","cost_model");--> statement-breakpoint
CREATE INDEX "tools_confidence_verified_idx" ON "tools" USING btree ("confidence","last_verified_at" NULLS FIRST);--> statement-breakpoint
CREATE INDEX "tools_updated_by_id_idx" ON "tools" USING btree ("updated_by_id");--> statement-breakpoint
CREATE INDEX "verification_tokens_expires_idx" ON "verification_tokens" USING btree ("expires");--> statement-breakpoint
CREATE INDEX "workspace_items_workspace_order_idx" ON "workspace_items" USING btree ("workspace_id","kind","order_index");--> statement-breakpoint
CREATE INDEX "workspace_items_user_id_idx" ON "workspace_items" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "workspace_items_tool_id_idx" ON "workspace_items" USING btree ("tool_id");--> statement-breakpoint
CREATE INDEX "workspace_items_step_id_idx" ON "workspace_items" USING btree ("step_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_items_tool_unique_idx" ON "workspace_items" USING btree ("workspace_id","tool_id") WHERE kind = 'tool' and tool_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_items_step_unique_idx" ON "workspace_items" USING btree ("workspace_id","step_id") WHERE kind = 'checklistStep' and step_id is not null;--> statement-breakpoint
CREATE INDEX "workspaces_user_updated_idx" ON "workspaces" USING btree ("user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "workspaces_user_status_idx" ON "workspaces" USING btree ("user_id","status","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "workspaces_playbook_id_idx" ON "workspaces" USING btree ("playbook_id");