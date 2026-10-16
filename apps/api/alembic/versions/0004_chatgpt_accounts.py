"""sign in with chatgpt: registration and tokens per user

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-16 18:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

import golf_api.db

revision = '0004'
down_revision = '0003'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table('chatgpt_accounts',
    sa.Column('user_id', sa.String(length=40), nullable=False),
    sa.Column('client_id', sa.String(length=200), nullable=False),
    sa.Column('subject', sa.String(length=200), nullable=False),
    sa.Column('email', sa.String(length=320), nullable=False),
    sa.Column('name', sa.String(length=200), nullable=False),
    sa.Column('access_token', sa.Text(), nullable=False),
    sa.Column('refresh_token', sa.Text(), nullable=False),
    sa.Column('expires_at', golf_api.db.UTCDateTime(), nullable=True),
    sa.Column('scopes', sa.Text(), nullable=False),
    sa.Column('problem', sa.String(length=40), nullable=False),
    sa.Column('updated_at', golf_api.db.UTCDateTime(), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_chatgpt_accounts_user_id_users'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('user_id', name=op.f('pk_chatgpt_accounts'))
    )


def downgrade() -> None:
    op.drop_table('chatgpt_accounts')
