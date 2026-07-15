## SUPABASE DUMP

\-- 1. Full table definition as json
\[
{
"column\_name": "id",
"data\_type": "uuid",
"is\_nullable": "NO"
},
{
"column\_name": "user\_id",
"data\_type": "uuid",
"is\_nullable": "NO"
},
{
"column\_name": "role",
"data\_type": "text",
"is\_nullable": "NO"
},
{
"column\_name": "hierarchy\_id",
"data\_type": "uuid",
"is\_nullable": "NO"
},
{
"column\_name": "congregation\_id",
"data\_type": "uuid",
"is\_nullable": "YES"
},
{
"column\_name": "scope\_level",
"data\_type": "text",
"is\_nullable": "NO"
},
{
"column\_name": "status",
"data\_type": "text",
"is\_nullable": "NO"
},
{
"column\_name": "start\_date",
"data\_type": "timestamp with time zone",
"is\_nullable": "NO"
},
{
"column\_name": "end\_date",
"data\_type": "timestamp with time zone",
"is\_nullable": "YES"
},
{
"column\_name": "created\_at",
"data\_type": "timestamp with time zone",
"is\_nullable": "NO"
}
]

\-- 2. RLS status + Policies as json

\[
{
"schemaname": "public",
"tablename": "user\_hierarchy\_access",
"policyname": "Users can read their own access",
"permissive": "PERMISSIVE",
"roles": "{authenticated}",
"cmd": "SELECT",
"qual": "(user\_id = auth.uid())",
"with\_check": null
}
]



\-- -- 3. Grants for anon/authenticated as json

\[
{
"grantee": "postgres",
"privilege\_type": "TRIGGER"
},
{
"grantee": "postgres",
"privilege\_type": "REFERENCES"
},
{
"grantee": "postgres",
"privilege\_type": "TRUNCATE"
},
{
"grantee": "postgres",
"privilege\_type": "DELETE"
},
{
"grantee": "postgres",
"privilege\_type": "UPDATE"
},
{
"grantee": "postgres",
"privilege\_type": "SELECT"
},
{
"grantee": "postgres",
"privilege\_type": "INSERT"
}
]





\-- 3 Auth settings and project Settings



{

&#x20; "project\_url": "https://cwdyixafvylzgtpsfmwr.supabase.co",

&#x20; "anon\_key\_first\_10\_chars": "eyJhbGciOiJI",

&#x20; "auth\_user\_test": {

&#x20;   "id": "2d1c0c9a-b443-4b06-bda7-ee1341188312",

&#x20;   "email": "treasurer@bosmont.test",

&#x20;   "email\_confirmed\_at": "2026-07-14T..."

&#x20; }

}

