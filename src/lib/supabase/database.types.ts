export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      call_requests: {
        Row: {
          created_at: string
          id: string
          resolved_at: string | null
          session_id: string
          status: string
        }
        Insert: {
          created_at?: string
          id?: string
          resolved_at?: string | null
          session_id: string
          status: string
        }
        Update: {
          created_at?: string
          id?: string
          resolved_at?: string | null
          session_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_requests_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "table_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      devices: {
        Row: {
          auth_user_id: string
          id: string
          role: string
          store_id: string
        }
        Insert: {
          auth_user_id: string
          id?: string
          role: string
          store_id: string
        }
        Update: {
          auth_user_id?: string
          id?: string
          role?: string
          store_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "devices_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      menu_items: {
        Row: {
          genre: string
          id: string
          image_url: string | null
          name: string
          options: Json
          price: number
          sold_out: boolean
          store_id: string
        }
        Insert: {
          genre: string
          id?: string
          image_url?: string | null
          name: string
          options?: Json
          price: number
          sold_out?: boolean
          store_id: string
        }
        Update: {
          genre?: string
          id?: string
          image_url?: string | null
          name?: string
          options?: Json
          price?: number
          sold_out?: boolean
          store_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "menu_items_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      order_items: {
        Row: {
          id: string
          menu_item_id: string
          name_snapshot: string
          note: string | null
          options_selected: Json
          options_summary: string | null
          order_id: string
          quantity: number
          status: string
          status_updated_at: string
          unit_price_snapshot: number
        }
        Insert: {
          id?: string
          menu_item_id: string
          name_snapshot: string
          note?: string | null
          options_selected?: Json
          options_summary?: string | null
          order_id: string
          quantity: number
          status: string
          status_updated_at?: string
          unit_price_snapshot: number
        }
        Update: {
          id?: string
          menu_item_id?: string
          name_snapshot?: string
          note?: string | null
          options_selected?: Json
          options_summary?: string | null
          order_id?: string
          quantity?: number
          status?: string
          status_updated_at?: string
          unit_price_snapshot?: number
        }
        Relationships: [
          {
            foreignKeyName: "order_items_menu_item_id_fkey"
            columns: ["menu_item_id"]
            isOneToOne: false
            referencedRelation: "menu_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          created_at: string
          id: string
          idempotency_key: string
          session_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          idempotency_key: string
          session_id: string
        }
        Update: {
          created_at?: string
          id?: string
          idempotency_key?: string
          session_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "orders_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "table_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      stores: {
        Row: {
          id: string
          name: string
        }
        Insert: {
          id?: string
          name: string
        }
        Update: {
          id?: string
          name?: string
        }
        Relationships: []
      }
      submit_order_rate_limits: {
        Row: {
          request_count: number
          session_id: string
          window_started_at: string
        }
        Insert: {
          request_count?: number
          session_id: string
          window_started_at?: string
        }
        Update: {
          request_count?: number
          session_id?: string
          window_started_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "submit_order_rate_limits_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: true
            referencedRelation: "table_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      table_sessions: {
        Row: {
          closed_at: string | null
          id: string
          party_size: number
          started_at: string
          status: string
          table_id: string
        }
        Insert: {
          closed_at?: string | null
          id?: string
          party_size: number
          started_at?: string
          status: string
          table_id: string
        }
        Update: {
          closed_at?: string | null
          id?: string
          party_size?: number
          started_at?: string
          status?: string
          table_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "table_sessions_table_id_fkey"
            columns: ["table_id"]
            isOneToOne: false
            referencedRelation: "tables"
            referencedColumns: ["id"]
          },
        ]
      }
      tables: {
        Row: {
          id: string
          label: string
          store_id: string
        }
        Insert: {
          id?: string
          label: string
          store_id: string
        }
        Update: {
          id?: string
          label?: string
          store_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tables_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      add_order_item: {
        Args: {
          p_menu_item_id: string
          p_option_selections: Json
          p_quantity: number
          p_session_id: string
        }
        Returns: Json
      }
      assert_device_role: {
        Args: { allowed_roles: string[] }
        Returns: undefined
      }
      close_session: { Args: { p_session_id: string }; Returns: Json }
      create_call_request: { Args: { p_session_id: string }; Returns: Json }
      custom_access_token_hook: { Args: { event: Json }; Returns: Json }
      get_ordering_context: { Args: { p_table_id: string }; Returns: Json }
      list_kitchen_feed: { Args: { p_store_id: string }; Returns: Json }
      list_register_feed: { Args: { p_store_id: string }; Returns: Json }
      provision_device: {
        Args: { p_role: string; p_setup_code: string; p_store_id: string }
        Returns: {
          auth_user_id: string
          id: string
          role: string
          store_id: string
        }
        SetofOptions: {
          from: "*"
          to: "devices"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      remove_order_item: { Args: { p_order_item_id: string }; Returns: Json }
      resolve_call_request: {
        Args: { p_call_request_id: string }
        Returns: Json
      }
      set_sold_out: {
        Args: { p_menu_item_id: string; p_sold_out: boolean }
        Returns: Json
      }
      start_session: {
        Args: { p_party_size: number; p_table_id: string }
        Returns: Json
      }
      submit_order: {
        Args: { p_idempotency_key: string; p_items: Json; p_session_id: string }
        Returns: Json
      }
      update_order_item_status: {
        Args: { p_order_item_id: string; p_status: string }
        Returns: Json
      }
      update_party_size: {
        Args: { p_party_size: number; p_session_id: string }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const

