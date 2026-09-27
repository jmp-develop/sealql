CREATE SCHEMA "drizzle_poc";
--> statement-breakpoint
CREATE TABLE "drizzle_poc"."children" (
	"id" integer PRIMARY KEY NOT NULL,
	"item_id" integer,
	"note" jsonb
);
--> statement-breakpoint
CREATE TABLE "drizzle_poc"."items" (
	"id" integer PRIMARY KEY NOT NULL,
	"public_text" text,
	"sealed" jsonb
);
--> statement-breakpoint
ALTER TABLE "drizzle_poc"."children" ADD CONSTRAINT "children_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "drizzle_poc"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "items_tokens_gin" ON "drizzle_poc"."items" USING gin (("sealed" -> 'tokens'));