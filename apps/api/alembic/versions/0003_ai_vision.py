"""ai settings: let the model look at still frames (putts)

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-16 14:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = '0003'
down_revision = '0002'
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table('ai_settings') as batch_op:
        batch_op.add_column(sa.Column('vision', sa.Boolean(), server_default='0', nullable=False))


def downgrade() -> None:
    with op.batch_alter_table('ai_settings') as batch_op:
        batch_op.drop_column('vision')
