"""Add per-event reminder configuration and safe worker state.

Revision ID: 0002_event_reminders
Revises: 0001_initial
"""

import sqlalchemy as sa
from alembic import op

revision = "0002_event_reminders"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("events", sa.Column("reminder_lead_minutes", sa.JSON(), nullable=True))
    op.add_column("events", sa.Column("reminder_channels", sa.JSON(), nullable=True))
    op.add_column(
        "reminders",
        sa.Column("lead_minutes", sa.Integer(), server_default=sa.text("0"), nullable=False),
    )
    op.add_column("reminders", sa.Column("claim_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("reminders", sa.Column("last_error_code", sa.String(length=64), nullable=True))
    with op.batch_alter_table("reminders") as batch_op:
        batch_op.create_unique_constraint(
            "uq_reminders_event_lead_channel",
            ["event_id", "lead_minutes", "channel"],
        )


def downgrade() -> None:
    with op.batch_alter_table("reminders") as batch_op:
        batch_op.drop_constraint("uq_reminders_event_lead_channel", type_="unique")
    op.drop_column("reminders", "last_error_code")
    op.drop_column("reminders", "claim_at")
    op.drop_column("reminders", "lead_minutes")
    op.drop_column("events", "reminder_channels")
    op.drop_column("events", "reminder_lead_minutes")
