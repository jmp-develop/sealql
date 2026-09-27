CREATE SCHEMA "gate_x1x2_kit";
--> statement-breakpoint
CREATE TABLE "gate_x1x2_kit"."plain" (
	"id" uuid PRIMARY KEY NOT NULL,
	"status" text
);
--> statement-breakpoint
CREATE TABLE "gate_x1x2_kit"."sealed" (
	"id" uuid PRIMARY KEY NOT NULL,
	"memo_ct" text
);
